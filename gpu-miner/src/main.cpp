#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef __APPLE__
#include <OpenCL/opencl.h>
#else
#include <CL/cl.h>
#endif

namespace {

struct Options {
  std::string challenge_hex;
  std::string difficulty_hex;
  std::string prefix_hex;
  std::string kernel_path = "kernels/keccak_miner.cl";
  cl_uint platform_index = 0;
  cl_uint device_index = 0;
  uint64_t start_counter = 0;
  size_t global_work_size = 1 << 20;
  size_t local_work_size = 256;
  uint64_t progress_ms = 1000;
};

std::string error_name(cl_int error) {
  switch (error) {
    case CL_SUCCESS: return "CL_SUCCESS";
    case CL_DEVICE_NOT_FOUND: return "CL_DEVICE_NOT_FOUND";
    case CL_DEVICE_NOT_AVAILABLE: return "CL_DEVICE_NOT_AVAILABLE";
    case CL_COMPILER_NOT_AVAILABLE: return "CL_COMPILER_NOT_AVAILABLE";
    case CL_MEM_OBJECT_ALLOCATION_FAILURE: return "CL_MEM_OBJECT_ALLOCATION_FAILURE";
    case CL_OUT_OF_RESOURCES: return "CL_OUT_OF_RESOURCES";
    case CL_OUT_OF_HOST_MEMORY: return "CL_OUT_OF_HOST_MEMORY";
    case CL_BUILD_PROGRAM_FAILURE: return "CL_BUILD_PROGRAM_FAILURE";
    case CL_INVALID_VALUE: return "CL_INVALID_VALUE";
    case CL_INVALID_DEVICE: return "CL_INVALID_DEVICE";
    case CL_INVALID_BINARY: return "CL_INVALID_BINARY";
    case CL_INVALID_BUILD_OPTIONS: return "CL_INVALID_BUILD_OPTIONS";
    case CL_INVALID_PROGRAM: return "CL_INVALID_PROGRAM";
    case CL_INVALID_KERNEL_NAME: return "CL_INVALID_KERNEL_NAME";
    case CL_INVALID_KERNEL: return "CL_INVALID_KERNEL";
    case CL_INVALID_KERNEL_ARGS: return "CL_INVALID_KERNEL_ARGS";
    case CL_INVALID_WORK_DIMENSION: return "CL_INVALID_WORK_DIMENSION";
    case CL_INVALID_WORK_GROUP_SIZE: return "CL_INVALID_WORK_GROUP_SIZE";
    default: return "OpenCL error " + std::to_string(error);
  }
}

void check(cl_int error, const std::string& what) {
  if (error != CL_SUCCESS) {
    throw std::runtime_error(what + ": " + error_name(error));
  }
}

std::string read_text_file(const std::string& path) {
  std::ifstream file(path, std::ios::binary);
  if (!file) {
    throw std::runtime_error("cannot open " + path);
  }
  std::ostringstream out;
  out << file.rdbuf();
  return out.str();
}

std::string strip_0x(std::string value) {
  if (value.rfind("0x", 0) == 0 || value.rfind("0X", 0) == 0) {
    return value.substr(2);
  }
  return value;
}

uint8_t hex_nibble(char ch) {
  if (ch >= '0' && ch <= '9') return static_cast<uint8_t>(ch - '0');
  if (ch >= 'a' && ch <= 'f') return static_cast<uint8_t>(ch - 'a' + 10);
  if (ch >= 'A' && ch <= 'F') return static_cast<uint8_t>(ch - 'A' + 10);
  throw std::runtime_error("invalid hex character");
}

std::vector<uint8_t> parse_hex_bytes(const std::string& input, size_t expected_size) {
  std::string clean = strip_0x(input);
  if (clean.size() != expected_size * 2) {
    throw std::runtime_error("expected " + std::to_string(expected_size) + " bytes of hex");
  }
  std::vector<uint8_t> bytes(expected_size);
  for (size_t i = 0; i < expected_size; ++i) {
    bytes[i] = static_cast<uint8_t>((hex_nibble(clean[i * 2]) << 4) | hex_nibble(clean[i * 2 + 1]));
  }
  return bytes;
}

uint64_t parse_u64(const std::string& value) {
  size_t pos = 0;
  const int base = (value.rfind("0x", 0) == 0 || value.rfind("0X", 0) == 0) ? 16 : 10;
  uint64_t parsed = std::stoull(value, &pos, base);
  if (pos != value.size()) {
    throw std::runtime_error("invalid integer: " + value);
  }
  return parsed;
}

std::string bytes_to_hex(const uint8_t* data, size_t size) {
  std::ostringstream out;
  out << "0x" << std::hex << std::setfill('0');
  for (size_t i = 0; i < size; ++i) {
    out << std::setw(2) << static_cast<unsigned>(data[i]);
  }
  return out.str();
}

std::array<uint8_t, 32> make_nonce(const std::vector<uint8_t>& prefix, uint64_t counter) {
  std::array<uint8_t, 32> nonce{};
  std::copy(prefix.begin(), prefix.end(), nonce.begin());
  nonce[24] = static_cast<uint8_t>(counter >> 56);
  nonce[25] = static_cast<uint8_t>(counter >> 48);
  nonce[26] = static_cast<uint8_t>(counter >> 40);
  nonce[27] = static_cast<uint8_t>(counter >> 32);
  nonce[28] = static_cast<uint8_t>(counter >> 24);
  nonce[29] = static_cast<uint8_t>(counter >> 16);
  nonce[30] = static_cast<uint8_t>(counter >> 8);
  nonce[31] = static_cast<uint8_t>(counter);
  return nonce;
}

void print_usage() {
  std::cerr
      << "Usage: hash256-gpu-miner --challenge 0x...32 --difficulty 0x...32 --prefix 0x...24 [options]\n\n"
      << "Options:\n"
      << "  --kernel PATH          OpenCL kernel path, default kernels/keccak_miner.cl\n"
      << "  --platform N           OpenCL platform index, default 0\n"
      << "  --device N             GPU device index inside platform, default 0\n"
      << "  --start N              Low 64-bit counter start, decimal or 0x, default 0\n"
      << "  --global N             Work items per dispatch, default 1048576\n"
      << "  --local N              Local work-group size, default 256; use 0 for driver choice\n"
      << "  --progress-ms N        Progress log interval, default 1000\n";
}

Options parse_args(int argc, char** argv) {
  Options options;
  for (int i = 1; i < argc; ++i) {
    std::string arg = argv[i];
    auto next = [&]() -> std::string {
      if (i + 1 >= argc) {
        throw std::runtime_error("missing value for " + arg);
      }
      return argv[++i];
    };

    if (arg == "--challenge") options.challenge_hex = next();
    else if (arg == "--difficulty") options.difficulty_hex = next();
    else if (arg == "--prefix") options.prefix_hex = next();
    else if (arg == "--kernel") options.kernel_path = next();
    else if (arg == "--platform") options.platform_index = static_cast<cl_uint>(parse_u64(next()));
    else if (arg == "--device") options.device_index = static_cast<cl_uint>(parse_u64(next()));
    else if (arg == "--start") options.start_counter = parse_u64(next());
    else if (arg == "--global") options.global_work_size = static_cast<size_t>(parse_u64(next()));
    else if (arg == "--local") options.local_work_size = static_cast<size_t>(parse_u64(next()));
    else if (arg == "--progress-ms") options.progress_ms = parse_u64(next());
    else if (arg == "--help" || arg == "-h") {
      print_usage();
      std::exit(0);
    } else {
      throw std::runtime_error("unknown option: " + arg);
    }
  }

  if (options.challenge_hex.empty() || options.difficulty_hex.empty() || options.prefix_hex.empty()) {
    print_usage();
    throw std::runtime_error("challenge, difficulty, and prefix are required");
  }
  if (options.global_work_size == 0) {
    throw std::runtime_error("--global must be positive");
  }
  return options;
}

std::string get_info_string(cl_device_id device, cl_device_info param) {
  size_t size = 0;
  check(clGetDeviceInfo(device, param, 0, nullptr, &size), "clGetDeviceInfo size");
  std::string value(size, '\0');
  check(clGetDeviceInfo(device, param, size, value.data(), nullptr), "clGetDeviceInfo");
  while (!value.empty() && value.back() == '\0') {
    value.pop_back();
  }
  return value;
}

}  // namespace

int main(int argc, char** argv) {
  try {
    const Options options = parse_args(argc, argv);
    const auto challenge = parse_hex_bytes(options.challenge_hex, 32);
    const auto difficulty = parse_hex_bytes(options.difficulty_hex, 32);
    const auto prefix = parse_hex_bytes(options.prefix_hex, 24);
    const std::string source = read_text_file(options.kernel_path);

    cl_int err = CL_SUCCESS;
    cl_uint platform_count = 0;
    check(clGetPlatformIDs(0, nullptr, &platform_count), "clGetPlatformIDs count");
    if (platform_count == 0 || options.platform_index >= platform_count) {
      throw std::runtime_error("OpenCL platform not found");
    }
    std::vector<cl_platform_id> platforms(platform_count);
    check(clGetPlatformIDs(platform_count, platforms.data(), nullptr), "clGetPlatformIDs");
    cl_platform_id platform = platforms[options.platform_index];

    cl_uint device_count = 0;
    check(clGetDeviceIDs(platform, CL_DEVICE_TYPE_GPU, 0, nullptr, &device_count), "clGetDeviceIDs count");
    if (device_count == 0 || options.device_index >= device_count) {
      throw std::runtime_error("OpenCL GPU device not found");
    }
    std::vector<cl_device_id> devices(device_count);
    check(clGetDeviceIDs(platform, CL_DEVICE_TYPE_GPU, device_count, devices.data(), nullptr), "clGetDeviceIDs");
    cl_device_id device = devices[options.device_index];

    std::cerr << "[gpu] device=" << get_info_string(device, CL_DEVICE_NAME) << "\n";

    cl_context context = clCreateContext(nullptr, 1, &device, nullptr, nullptr, &err);
    check(err, "clCreateContext");
    cl_command_queue queue = clCreateCommandQueue(context, device, 0, &err);
    check(err, "clCreateCommandQueue");

    const char* source_ptr = source.data();
    const size_t source_size = source.size();
    cl_program program = clCreateProgramWithSource(context, 1, &source_ptr, &source_size, &err);
    check(err, "clCreateProgramWithSource");

    err = clBuildProgram(program, 1, &device, "-cl-std=CL1.2", nullptr, nullptr);
    if (err != CL_SUCCESS) {
      size_t log_size = 0;
      clGetProgramBuildInfo(program, device, CL_PROGRAM_BUILD_LOG, 0, nullptr, &log_size);
      std::string log(log_size, '\0');
      clGetProgramBuildInfo(program, device, CL_PROGRAM_BUILD_LOG, log_size, log.data(), nullptr);
      std::cerr << log << "\n";
      check(err, "clBuildProgram");
    }

    cl_kernel kernel = clCreateKernel(program, "search_kernel", &err);
    check(err, "clCreateKernel");

    cl_mem challenge_buf = clCreateBuffer(context, CL_MEM_READ_ONLY | CL_MEM_COPY_HOST_PTR, challenge.size(), const_cast<uint8_t*>(challenge.data()), &err);
    check(err, "clCreateBuffer challenge");
    cl_mem difficulty_buf = clCreateBuffer(context, CL_MEM_READ_ONLY | CL_MEM_COPY_HOST_PTR, difficulty.size(), const_cast<uint8_t*>(difficulty.data()), &err);
    check(err, "clCreateBuffer difficulty");
    cl_mem prefix_buf = clCreateBuffer(context, CL_MEM_READ_ONLY | CL_MEM_COPY_HOST_PTR, prefix.size(), const_cast<uint8_t*>(prefix.data()), &err);
    check(err, "clCreateBuffer prefix");

    uint32_t found = 0;
    uint64_t result_counter = 0;
    std::array<uint8_t, 32> result_hash{};
    cl_mem found_buf = clCreateBuffer(context, CL_MEM_READ_WRITE | CL_MEM_COPY_HOST_PTR, sizeof(found), &found, &err);
    check(err, "clCreateBuffer found");
    cl_mem counter_buf = clCreateBuffer(context, CL_MEM_WRITE_ONLY, sizeof(result_counter), nullptr, &err);
    check(err, "clCreateBuffer result counter");
    cl_mem hash_buf = clCreateBuffer(context, CL_MEM_WRITE_ONLY, result_hash.size(), nullptr, &err);
    check(err, "clCreateBuffer result hash");

    check(clSetKernelArg(kernel, 0, sizeof(challenge_buf), &challenge_buf), "clSetKernelArg challenge");
    check(clSetKernelArg(kernel, 1, sizeof(difficulty_buf), &difficulty_buf), "clSetKernelArg difficulty");
    check(clSetKernelArg(kernel, 2, sizeof(prefix_buf), &prefix_buf), "clSetKernelArg prefix");
    check(clSetKernelArg(kernel, 4, sizeof(found_buf), &found_buf), "clSetKernelArg found");
    check(clSetKernelArg(kernel, 5, sizeof(counter_buf), &counter_buf), "clSetKernelArg result counter");
    check(clSetKernelArg(kernel, 6, sizeof(hash_buf), &hash_buf), "clSetKernelArg result hash");

    uint64_t counter = options.start_counter;
    uint64_t total_hashes = 0;
    const auto start_time = std::chrono::steady_clock::now();
    auto last_progress = start_time;

    while (true) {
      found = 0;
      check(clEnqueueWriteBuffer(queue, found_buf, CL_TRUE, 0, sizeof(found), &found, 0, nullptr, nullptr), "reset found");
      check(clSetKernelArg(kernel, 3, sizeof(counter), &counter), "clSetKernelArg start counter");

      size_t global = options.global_work_size;
      size_t local = options.local_work_size;
      const size_t* local_ptr = local == 0 ? nullptr : &local;
      if (local != 0 && global % local != 0) {
        global = ((global / local) + 1) * local;
      }

      check(clEnqueueNDRangeKernel(queue, kernel, 1, nullptr, &global, local_ptr, 0, nullptr, nullptr), "clEnqueueNDRangeKernel");
      check(clFinish(queue), "clFinish");
      check(clEnqueueReadBuffer(queue, found_buf, CL_TRUE, 0, sizeof(found), &found, 0, nullptr, nullptr), "read found");

      total_hashes += static_cast<uint64_t>(global);
      if (found != 0) {
        check(clEnqueueReadBuffer(queue, counter_buf, CL_TRUE, 0, sizeof(result_counter), &result_counter, 0, nullptr, nullptr), "read result counter");
        check(clEnqueueReadBuffer(queue, hash_buf, CL_TRUE, 0, result_hash.size(), result_hash.data(), 0, nullptr, nullptr), "read result hash");
        const auto nonce = make_nonce(prefix, result_counter);
        std::cout << "{\"type\":\"found\",\"nonceHex\":\"" << bytes_to_hex(nonce.data(), nonce.size())
                  << "\",\"resultHex\":\"" << bytes_to_hex(result_hash.data(), result_hash.size())
                  << "\",\"counter\":\"" << result_counter << "\"}\n";
        break;
      }

      counter += static_cast<uint64_t>(global);
      const auto now = std::chrono::steady_clock::now();
      const auto since_progress = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_progress).count();
      if (since_progress >= static_cast<long long>(options.progress_ms)) {
        const double seconds = std::chrono::duration<double>(now - start_time).count();
        const double mh = seconds > 0.0 ? static_cast<double>(total_hashes) / seconds / 1'000'000.0 : 0.0;
        std::cerr << "[gpu] hashes=" << total_hashes << " rate=" << std::fixed << std::setprecision(2)
                  << mh << " MH/s nextCounter=" << counter << "\n";
        last_progress = now;
      }
    }

    clReleaseMemObject(hash_buf);
    clReleaseMemObject(counter_buf);
    clReleaseMemObject(found_buf);
    clReleaseMemObject(prefix_buf);
    clReleaseMemObject(difficulty_buf);
    clReleaseMemObject(challenge_buf);
    clReleaseKernel(kernel);
    clReleaseProgram(program);
    clReleaseCommandQueue(queue);
    clReleaseContext(context);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "error: " << error.what() << "\n";
    return 1;
  }
}
