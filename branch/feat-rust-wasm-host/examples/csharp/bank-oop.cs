using System;
using System.Collections.Generic;

class InsufficientFunds : Exception
{
    public InsufficientFunds(decimal need, decimal have) : base($"need {need:C}, have {have:C}") { }
}

abstract class Account
{
    public string Owner { get; }
    public decimal Balance { get; protected set; }
    protected readonly List<string> History = new List<string>();

    protected Account(string owner, decimal opening) { Owner = owner; Balance = opening; }

    public void Deposit(decimal amount)
    {
        if (amount <= 0) throw new ArgumentException("deposit must be positive");
        Balance += amount; History.Add($"+{amount}");
    }

    public virtual void Withdraw(decimal amount)
    {
        if (amount > Balance) throw new InsufficientFunds(amount, Balance);
        Balance -= amount; History.Add($"-{amount}");
    }

    public abstract string Kind { get; }
    public override string ToString() => $"{Kind,-8} {Owner,-6} {Balance,10:F2}  [{string.Join(" ", History)}]";
}

class Checking : Account
{
    readonly decimal overdraft;
    public Checking(string o, decimal open, decimal overdraft) : base(o, open) { this.overdraft = overdraft; }
    public override string Kind => "Checking";
    public override void Withdraw(decimal amount)
    {
        if (amount > Balance + overdraft) throw new InsufficientFunds(amount, Balance + overdraft);
        Balance -= amount; History.Add($"-{amount}");
    }
}

class Savings : Account
{
    public Savings(string o, decimal open) : base(o, open) { }
    public override string Kind => "Savings";
    public void AddInterest(decimal rate) => Deposit(Math.Round(Balance * rate, 2));
}

class Program
{
    static void Main()
    {
        var accounts = new List<Account> { new Checking("Ada", 100, 50), new Savings("Linus", 1000) };
        accounts[0].Withdraw(120);                 // uses the overdraft
        ((Savings)accounts[1]).AddInterest(0.02m);
        foreach (var a in accounts) Console.WriteLine(a);

        try { accounts[1].Withdraw(5000); }
        catch (InsufficientFunds e) { Console.WriteLine("declined: " + e.Message); }
    }
}
