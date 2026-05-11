cmake_minimum_required(VERSION 3.20)

project(hash256_gpu_miner LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(OpenCL REQUIRED)

add_executable(hash256-gpu-miner
  src/main.cpp
)

target_link_libraries(hash256-gpu-miner PRIVATE OpenCL::OpenCL)

add_custom_command(TARGET hash256-gpu-miner POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_directory
    ${CMAKE_CURRENT_SOURCE_DIR}/kernels
    $<TARGET_FILE_DIR:hash256-gpu-miner>/kernels
)

if (MSVC)
  target_compile_options(hash256-gpu-miner PRIVATE /O2 /W4)
else()
  target_compile_options(hash256-gpu-miner PRIVATE -O3 -Wall -Wextra)
endif()
