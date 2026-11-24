using System;
using System.Collections.Generic;
using System.Linq;

class Program
{
    class Employee { public string Name; public string Dept; public int Salary; public int Age; }

    static void Main()
    {
        var staff = new List<Employee>
        {
            new Employee { Name = "Ana",   Dept = "Eng",   Salary = 120, Age = 31 },
            new Employee { Name = "Bo",    Dept = "Eng",   Salary = 105, Age = 27 },
            new Employee { Name = "Cy",    Dept = "Ops",   Salary = 80,  Age = 45 },
            new Employee { Name = "Di",    Dept = "Ops",   Salary = 85,  Age = 38 },
            new Employee { Name = "Ed",    Dept = "Sales", Salary = 70,  Age = 29 },
        };

        Console.WriteLine("-- average salary per department");
        foreach (var g in staff.GroupBy(e => e.Dept).Select(g => new { Dept = g.Key, Avg = g.Average(e => e.Salary), N = g.Count() }))
            Console.WriteLine($"{g.Dept,-6} avg={g.Avg,6:F1} n={g.N}");

        Console.WriteLine("-- top earner per department");
        foreach (var e in staff.GroupBy(x => x.Dept).Select(g => g.OrderByDescending(x => x.Salary).First()))
            Console.WriteLine($"{e.Dept,-6} {e.Name} ({e.Salary})");

        Console.WriteLine("-- join with budgets");
        var budgets = new Dictionary<string, int> { ["Eng"] = 300, ["Ops"] = 150, ["Sales"] = 90 };
        var joined = from e in staff
                     join b in budgets on e.Dept equals b.Key
                     group e by new { e.Dept, b.Value } into g
                     select new { g.Key.Dept, Used = g.Sum(x => x.Salary), Budget = g.Key.Value };
        foreach (var r in joined) Console.WriteLine($"{r.Dept,-6} {r.Used}/{r.Budget} {(r.Used > r.Budget ? "OVER" : "ok")}");

        Console.WriteLine("-- running total (Aggregate)");
        int running = 0;
        Console.WriteLine(string.Join(" ", staff.Select(e => running += e.Salary)));

        Console.WriteLine("-- pagination: page 2, size 2");
        Console.WriteLine(string.Join(", ", staff.OrderBy(e => e.Name).Skip(2).Take(2).Select(e => e.Name)));
    }
}
