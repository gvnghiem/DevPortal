#include <stdio.h>

#define N 12

void print_arr(const char *label, int a[], int n) {
    printf("%-10s", label);
    for (int i = 0; i < n; i++) printf("%3d", a[i]);
    printf("\n");
}

int bubble_sort(int a[], int n) {
    int swaps = 0;
    for (int i = 0; i < n - 1; i++)
        for (int j = 0; j < n - 1 - i; j++)
            if (a[j] > a[j + 1]) {
                int t = a[j]; a[j] = a[j + 1]; a[j + 1] = t;
                swaps++;
            }
    return swaps;
}

int insertion_sort(int a[], int n) {
    int moves = 0;
    for (int i = 1; i < n; i++) {
        int key = a[i];
        int j = i - 1;
        while (j >= 0 && a[j] > key) {
            a[j + 1] = a[j];
            j--;
            moves++;
        }
        a[j + 1] = key;
    }
    return moves;
}

int main() {
    int a[N] = {42, 7, 19, 3, 88, 23, 61, 5, 34, 12, 70, 1};
    int b[N] = {42, 7, 19, 3, 88, 23, 61, 5, 34, 12, 70, 1};
    print_arr("input:", a, N);
    int s1 = bubble_sort(a, N);
    int s2 = insertion_sort(b, N);
    print_arr("bubble:", a, N);
    print_arr("insertion:", b, N);
    printf("bubble swaps = %d, insertion shifts = %d\n", s1, s2);
    return 0;
}
