using System;
using System.Collections.Generic;
using System.Linq;

class Program
{
    static void Main()
    {
        Console.WriteLine("Hello from C# on " + Environment.Version + "!");

        var langs = new List<string> { "C#", "Rust", "C", "Python", "TypeScript" };
        Console.WriteLine("sorted by length: " + string.Join(", ", langs.OrderBy(s => s.Length).ThenBy(s => s)));

        foreach (var g in langs.GroupBy(s => s.Length).OrderBy(g => g.Key))
            Console.WriteLine($"{g.Key} letters: {string.Join(", ", g)}");

        int sum = Enumerable.Range(1, 100).Where(n => n % 3 == 0 || n % 5 == 0).Sum();
        Console.WriteLine($"sum of multiples of 3 or 5 up to 100 = {sum}");

        (int min, int max) = (langs.Min(s => s.Length), langs.Max(s => s.Length));
        Console.WriteLine($"shortest name: {min} chars, longest: {max} chars");
    }
}
