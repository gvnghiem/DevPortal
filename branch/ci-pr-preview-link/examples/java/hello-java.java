import java.util.*;
import java.util.stream.*;

public class Main {
    public static void main(String[] args) {
        System.out.println("Hello from Java " + System.getProperty("java.version") + "!");

        List<String> langs = Arrays.asList("Java", "Rust", "C", "Python", "TypeScript");
        System.out.println("sorted by length: " +
            langs.stream().sorted(Comparator.comparingInt(String::length).thenComparing(s -> s)).collect(Collectors.toList()));

        Map<Integer, List<String>> byLen = langs.stream().collect(Collectors.groupingBy(String::length, TreeMap::new, Collectors.toList()));
        byLen.forEach((len, names) -> System.out.println(len + " letters: " + names));

        int sum = IntStream.rangeClosed(1, 100).filter(n -> n % 3 == 0 || n % 5 == 0).sum();
        System.out.println("sum of multiples of 3 or 5 up to 100 = " + sum);
    }
}
