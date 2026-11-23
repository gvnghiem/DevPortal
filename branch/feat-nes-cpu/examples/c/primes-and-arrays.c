#include <stdio.h>

#define LIMIT 60

int main() {
    int is_prime[LIMIT + 1];
    int i, j;
    for (i = 0; i <= LIMIT; i++) is_prime[i] = 1;
    is_prime[0] = is_prime[1] = 0;
    for (i = 2; i * i <= LIMIT; i++)
        if (is_prime[i])
            for (j = i * i; j <= LIMIT; j += i) is_prime[j] = 0;

    printf("primes up to %d:\n", LIMIT);
    int count = 0;
    for (i = 2; i <= LIMIT; i++) {
        if (is_prime[i]) {
            printf("%3d", i);
            count++;
            if (count % 10 == 0) printf("\n");
        }
    }
    printf("\n(%d primes)\n", count);

    /* pointer walk over an array */
    int data[5] = {10, 20, 30, 40, 50};
    int *p = data;
    int sum = 0;
    for (i = 0; i < 5; i++) {
        sum += *(p + i);
    }
    printf("sum via pointer = %d\n", sum);
    return 0;
}
