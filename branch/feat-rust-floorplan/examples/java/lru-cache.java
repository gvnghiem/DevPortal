import java.util.*;

public class Main {
    // LRU cache built on LinkedHashMap's access-order mode
    static class LRU<K, V> extends LinkedHashMap<K, V> {
        private final int capacity;
        LRU(int capacity) { super(16, 0.75f, true); this.capacity = capacity; }
        @Override protected boolean removeEldestEntry(Map.Entry<K, V> eldest) { return size() > capacity; }
    }

    public static void main(String[] args) {
        LRU<String, Integer> cache = new LRU<>(3);
        cache.put("a", 1);
        cache.put("b", 2);
        cache.put("c", 3);
        System.out.println("start:        " + cache.keySet());
        cache.get("a");
        System.out.println("read a:       " + cache.keySet());
        cache.put("d", 4);
        System.out.println("put d (evict b): " + cache.keySet());
        cache.put("e", 5);
        System.out.println("put e (evict c): " + cache.keySet());
        System.out.println("contains b? " + cache.containsKey("b"));
    }
}
