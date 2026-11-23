import java.util.*;

public class Main {
    static class InsufficientFundsException extends Exception {
        InsufficientFundsException(String msg) { super(msg); }
    }

    interface Account {
        void deposit(double amount);
        void withdraw(double amount) throws InsufficientFundsException;
        double getBalance();
    }

    static abstract class BaseAccount implements Account {
        protected double balance;
        protected final String owner;
        protected final List<String> history = new ArrayList<>();
        BaseAccount(String owner, double opening) { this.owner = owner; this.balance = opening; }
        public void deposit(double amount) { balance += amount; history.add("deposit " + amount); }
        public double getBalance() { return balance; }
        abstract double monthlyInterest();
    }

    static class Savings extends BaseAccount {
        Savings(String owner, double opening) { super(owner, opening); }
        public void withdraw(double amount) throws InsufficientFundsException {
            if (amount > balance) throw new InsufficientFundsException(owner + ": cannot withdraw " + amount + ", balance " + balance);
            balance -= amount; history.add("withdraw " + amount);
        }
        double monthlyInterest() { return balance * 0.02 / 12; }
    }

    static class Checking extends BaseAccount {
        Checking(String owner, double opening) { super(owner, opening); }
        public void withdraw(double amount) throws InsufficientFundsException {
            if (amount > balance + 100) throw new InsufficientFundsException(owner + ": overdraft limit exceeded");
            balance -= amount; history.add("withdraw " + amount);
        }
        double monthlyInterest() { return 0; }
    }

    public static void main(String[] args) {
        List<BaseAccount> accounts = new ArrayList<>();
        accounts.add(new Savings("Ada", 500));
        accounts.add(new Checking("Linus", 50));
        for (BaseAccount a : accounts) {
            try {
                a.deposit(25);
                a.withdraw(160);
                a.withdraw(500);
            } catch (InsufficientFundsException e) {
                System.out.println("error: " + e.getMessage());
            }
            System.out.printf("%s (%s): balance=%.2f interest=%.2f history=%s%n",
                a.owner, a.getClass().getSimpleName(), a.getBalance(), a.monthlyInterest(), a.history);
        }
    }
}
