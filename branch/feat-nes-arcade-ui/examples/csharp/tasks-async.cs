using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

class Program
{
    static async Task<int> SquareAfterAsync(int n, int ms)
    {
        await Task.Delay(ms);
        Console.WriteLine($"  finished {n} on a pool thread: {Thread.CurrentThread.IsThreadPoolThread}");
        return n * n;
    }

    static async Task RunAsync()
    {
        Console.WriteLine("sequential:");
        var a = await SquareAfterAsync(2, 50);
        var b = await SquareAfterAsync(3, 50);
        Console.WriteLine($"  {a} + {b} = {a + b}");

        Console.WriteLine("parallel with Task.WhenAll:");
        var results = await Task.WhenAll(Enumerable.Range(1, 5).Select(i => SquareAfterAsync(i, 120 - i * 20)));
        Console.WriteLine("  results (input order): " + string.Join(", ", results));

        Console.WriteLine("lock + Parallel.For:");
        long total = 0; var gate = new object();
        Parallel.For(1, 1001, i => { lock (gate) total += i; });
        Console.WriteLine("  sum 1..1000 = " + total);

        Console.WriteLine("cancellation:");
        var cts = new CancellationTokenSource(80);
        try { await Task.Delay(1000, cts.Token); }
        catch (OperationCanceledException) { Console.WriteLine("  cancelled after ~80 ms"); }
    }

    static void Main()
    {
        RunAsync().GetAwaiter().GetResult();   // classic Main: works on every C# version
    }
}
