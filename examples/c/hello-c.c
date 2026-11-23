#include <stdio.h>

int main() {
    printf("Hello from C!\n");
    int n = 5;
    int fact = 1;
    for (int i = 2; i <= n; i++) fact *= i;
    printf("%d! = %d\n", n, fact);
    printf("size of int = %d bytes\n", (int)sizeof(int));
    return 0;
}
