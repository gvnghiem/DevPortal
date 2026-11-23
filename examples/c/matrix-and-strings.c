#include <stdio.h>
#include <string.h>
#include <ctype.h>

void multiply(int a[2][3], int b[3][2], int out[2][2]) {
    for (int i = 0; i < 2; i++)
        for (int j = 0; j < 2; j++) {
            out[i][j] = 0;
            for (int k = 0; k < 3; k++) out[i][j] += a[i][k] * b[k][j];
        }
}

int is_palindrome(const char *s) {
    int i = 0, j = (int)strlen(s) - 1;
    while (i < j) {
        while (i < j && !isalnum((unsigned char)s[i])) i++;
        while (i < j && !isalnum((unsigned char)s[j])) j--;
        if (tolower((unsigned char)s[i]) != tolower((unsigned char)s[j])) return 0;
        i++; j--;
    }
    return 1;
}

void check(const char *s) {
    printf("\"%s\" -> %s\n", s, is_palindrome(s) ? "palindrome" : "not a palindrome");
}

int main() {
    int a[2][3] = {{1, 2, 3}, {4, 5, 6}};
    int b[3][2] = {{7, 8}, {9, 10}, {11, 12}};
    int c[2][2];
    multiply(a, b, c);
    printf("A x B =\n");
    for (int i = 0; i < 2; i++) printf("[%4d %4d]\n", c[i][0], c[i][1]);

    check("A man, a plan, a canal: Panama");
    check("Hello, World");
    check("Was it a car or a cat I saw?");

    const char *src = "devportal";
    char word[20];
    int n = 0;
    while (src[n] != 0) { word[n] = toupper(src[n]); n++; }
    word[n] = 0;
    printf("%s has %d letters\n", word, n);
    return 0;
}
