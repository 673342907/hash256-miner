typedef unsigned char u8;
typedef unsigned int u32;
typedef unsigned long u64;

__constant u64 RC[24] = {
    0x0000000000000001UL, 0x0000000000008082UL, 0x800000000000808aUL, 0x8000000080008000UL,
    0x000000000000808bUL, 0x0000000080000001UL, 0x8000000080008081UL, 0x8000000000008009UL,
    0x000000000000008aUL, 0x0000000000000088UL, 0x0000000080008009UL, 0x000000008000000aUL,
    0x000000008000808bUL, 0x800000000000008bUL, 0x8000000000008089UL, 0x8000000000008003UL,
    0x8000000000008002UL, 0x8000000000000080UL, 0x000000000000800aUL, 0x800000008000000aUL,
    0x8000000080008081UL, 0x8000000000008080UL, 0x0000000080000001UL, 0x8000000080008008UL
};

static inline u64 rol64(u64 x, int n) {
    return (x << n) | (x >> (64 - n));
}

static inline u64 load64_le(const u8 *p) {
    return ((u64)p[0]) |
        ((u64)p[1] << 8) |
        ((u64)p[2] << 16) |
        ((u64)p[3] << 24) |
        ((u64)p[4] << 32) |
        ((u64)p[5] << 40) |
        ((u64)p[6] << 48) |
        ((u64)p[7] << 56);
}

static inline void store64_le(u64 v, u8 *p) {
    p[0] = (u8)(v);
    p[1] = (u8)(v >> 8);
    p[2] = (u8)(v >> 16);
    p[3] = (u8)(v >> 24);
    p[4] = (u8)(v >> 32);
    p[5] = (u8)(v >> 40);
    p[6] = (u8)(v >> 48);
    p[7] = (u8)(v >> 56);
}

static void keccak_f1600(u64 st[25]) {
    for (int round = 0; round < 24; round++) {
        u64 bc0 = st[0] ^ st[5] ^ st[10] ^ st[15] ^ st[20];
        u64 bc1 = st[1] ^ st[6] ^ st[11] ^ st[16] ^ st[21];
        u64 bc2 = st[2] ^ st[7] ^ st[12] ^ st[17] ^ st[22];
        u64 bc3 = st[3] ^ st[8] ^ st[13] ^ st[18] ^ st[23];
        u64 bc4 = st[4] ^ st[9] ^ st[14] ^ st[19] ^ st[24];

        u64 t = bc4 ^ rol64(bc1, 1);
        st[0] ^= t; st[5] ^= t; st[10] ^= t; st[15] ^= t; st[20] ^= t;
        t = bc0 ^ rol64(bc2, 1);
        st[1] ^= t; st[6] ^= t; st[11] ^= t; st[16] ^= t; st[21] ^= t;
        t = bc1 ^ rol64(bc3, 1);
        st[2] ^= t; st[7] ^= t; st[12] ^= t; st[17] ^= t; st[22] ^= t;
        t = bc2 ^ rol64(bc4, 1);
        st[3] ^= t; st[8] ^= t; st[13] ^= t; st[18] ^= t; st[23] ^= t;
        t = bc3 ^ rol64(bc0, 1);
        st[4] ^= t; st[9] ^= t; st[14] ^= t; st[19] ^= t; st[24] ^= t;

        u64 x = st[1];
        t = st[10]; st[10] = rol64(x, 1); x = t;
        t = st[7]; st[7] = rol64(x, 3); x = t;
        t = st[11]; st[11] = rol64(x, 6); x = t;
        t = st[17]; st[17] = rol64(x, 10); x = t;
        t = st[18]; st[18] = rol64(x, 15); x = t;
        t = st[3]; st[3] = rol64(x, 21); x = t;
        t = st[5]; st[5] = rol64(x, 28); x = t;
        t = st[16]; st[16] = rol64(x, 36); x = t;
        t = st[8]; st[8] = rol64(x, 45); x = t;
        t = st[21]; st[21] = rol64(x, 55); x = t;
        t = st[24]; st[24] = rol64(x, 2); x = t;
        t = st[4]; st[4] = rol64(x, 14); x = t;
        t = st[15]; st[15] = rol64(x, 27); x = t;
        t = st[23]; st[23] = rol64(x, 41); x = t;
        t = st[19]; st[19] = rol64(x, 56); x = t;
        t = st[13]; st[13] = rol64(x, 8); x = t;
        t = st[12]; st[12] = rol64(x, 25); x = t;
        t = st[2]; st[2] = rol64(x, 43); x = t;
        t = st[20]; st[20] = rol64(x, 62); x = t;
        t = st[14]; st[14] = rol64(x, 18); x = t;
        t = st[22]; st[22] = rol64(x, 39); x = t;
        t = st[9]; st[9] = rol64(x, 61); x = t;
        t = st[6]; st[6] = rol64(x, 20); x = t;
        st[1] = rol64(x, 44);

        for (int y = 0; y < 25; y += 5) {
            u64 a0 = st[y + 0];
            u64 a1 = st[y + 1];
            u64 a2 = st[y + 2];
            u64 a3 = st[y + 3];
            u64 a4 = st[y + 4];
            st[y + 0] = a0 ^ ((~a1) & a2);
            st[y + 1] = a1 ^ ((~a2) & a3);
            st[y + 2] = a2 ^ ((~a3) & a4);
            st[y + 3] = a3 ^ ((~a4) & a0);
            st[y + 4] = a4 ^ ((~a0) & a1);
        }

        st[0] ^= RC[round];
    }
}

static void keccak256_64(const u8 message[64], u8 out[32]) {
    u64 st[25];
    for (int i = 0; i < 25; i++) {
        st[i] = 0;
    }

    for (int i = 0; i < 8; i++) {
        st[i] ^= load64_le(message + i * 8);
    }

    st[8] ^= 0x0000000000000001UL;
    st[16] ^= 0x8000000000000000UL;

    keccak_f1600(st);

    for (int i = 0; i < 4; i++) {
        store64_le(st[i], out + i * 8);
    }
}

static inline int hash_less_than_difficulty(const u8 hash[32], __global const u8 *difficulty) {
    for (int i = 0; i < 32; i++) {
        u8 a = hash[i];
        u8 b = difficulty[i];
        if (a < b) {
            return 1;
        }
        if (a > b) {
            return 0;
        }
    }
    return 0;
}

__kernel void search_kernel(
    __global const u8 *challenge,
    __global const u8 *difficulty,
    __global const u8 *prefix,
    const u64 start_counter,
    __global volatile u32 *found,
    __global u64 *result_counter,
    __global u8 *result_hash)
{
    if (*found != 0) {
        return;
    }

    const u64 gid = (u64)get_global_id(0);
    const u64 counter = start_counter + gid;
    u8 msg[64];
    u8 hash[32];

    for (int i = 0; i < 32; i++) {
        msg[i] = challenge[i];
    }
    for (int i = 0; i < 24; i++) {
        msg[32 + i] = prefix[i];
    }
    msg[56] = (u8)(counter >> 56);
    msg[57] = (u8)(counter >> 48);
    msg[58] = (u8)(counter >> 40);
    msg[59] = (u8)(counter >> 32);
    msg[60] = (u8)(counter >> 24);
    msg[61] = (u8)(counter >> 16);
    msg[62] = (u8)(counter >> 8);
    msg[63] = (u8)(counter);

    keccak256_64(msg, hash);

    if (hash_less_than_difficulty(hash, difficulty)) {
        if (atomic_cmpxchg(found, 0u, 1u) == 0u) {
            *result_counter = counter;
            for (int i = 0; i < 32; i++) {
                result_hash[i] = hash[i];
            }
        }
    }
}
