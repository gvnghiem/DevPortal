// C++ (subset simulator): a tiny bank using arrays and functions.
#include <iostream>
#include <iomanip>
using namespace std;

int ids[3] = {101, 102, 103};
double balance[3] = {250.0, 90.5, 1200.0};

int find(int id) {
    for (int i = 0; i < 3; i++) if (ids[i] == id) return i;
    return -1;
}

int withdraw(int id, double amount) {
    int i = find(id);
    if (i < 0) { cout << "  no such account " << id << endl; return 0; }
    if (amount > balance[i]) { cout << "  insufficient funds in " << id << endl; return 0; }
    balance[i] = balance[i] - amount;
    return 1;
}

int transfer(int from, int to, double amount) {
    int j = find(to);
    if (j < 0) { cout << "  unknown target " << to << endl; return 0; }
    if (!withdraw(from, amount)) return 0;
    balance[j] = balance[j] + amount;
    return 1;
}

void report() {
    cout << fixed << setprecision(2);
    for (int i = 0; i < 3; i++)
        cout << "  #" << ids[i] << "  $" << setw(8) << balance[i] << endl;
}

int main() {
    cout << "Opening balances" << endl;
    report();
    cout << "transfer 101 -> 102 : 75.25" << endl;
    transfer(101, 102, 75.25);
    cout << "transfer 102 -> 103 : 500" << endl;
    transfer(102, 103, 500);
    cout << "transfer 103 -> 999 : 10" << endl;
    transfer(103, 999, 10);
    cout << "Final balances" << endl;
    report();
    return 0;
}
