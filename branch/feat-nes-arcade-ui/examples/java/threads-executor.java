import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

public class Main {
    static long fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }

    public static void main(String[] args) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(4);
        List<Future<String>> futures = new ArrayList<>();
        for (int n : new int[]{20, 25, 30, 32}) {
            futures.add(pool.submit(() -> "fib(" + n + ") = " + fib(n)));
        }
        for (Future<String> f : futures) System.out.println(f.get());

        // many threads incrementing a shared counter safely
        AtomicInteger counter = new AtomicInteger();
        CountDownLatch done = new CountDownLatch(8);
        for (int t = 0; t < 8; t++) {
            pool.execute(() -> {
                for (int i = 0; i < 10_000; i++) counter.incrementAndGet();
                done.countDown();
            });
        }
        done.await();
        System.out.println("counter = " + counter.get() + " (expected 80000)");
        pool.shutdown();
        System.out.println("pool terminated: " + pool.awaitTermination(2, TimeUnit.SECONDS));
    }
}
