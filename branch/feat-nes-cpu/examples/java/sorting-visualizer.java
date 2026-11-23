import java.util.*;

public class Main {
    static void bar(int[] a, int hi, int lo) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < a.length; i++) {
            String cell = String.format("%2d", a[i]);
            sb.append((i == hi || i == lo) ? "[" + cell + "]" : " " + cell + " ");
        }
        System.out.println(sb);
    }

    static void quickSort(int[] a, int lo, int hi, int[] steps) {
        if (lo >= hi) return;
        int pivot = a[hi], i = lo - 1;
        for (int j = lo; j < hi; j++) {
            if (a[j] < pivot) {
                i++;
                int t = a[i]; a[i] = a[j]; a[j] = t;
                steps[0]++;
                bar(a, i, j);
            }
        }
        int t = a[i + 1]; a[i + 1] = a[hi]; a[hi] = t;
        steps[0]++;
        bar(a, i + 1, hi);
        quickSort(a, lo, i, steps);
        quickSort(a, i + 2, hi, steps);
    }

    public static void main(String[] args) {
        int[] a = {9, 4, 7, 1, 8, 2, 6, 3, 5};
        System.out.println("quicksort steps (brackets = elements just swapped):");
        bar(a, -1, -1);
        int[] steps = {0};
        quickSort(a, 0, a.length - 1, steps);
        System.out.println("sorted: " + Arrays.toString(a) + " in " + steps[0] + " swaps");
    }
}
