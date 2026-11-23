#include <iostream>
using namespace std;

int main() {
    cout << "Hello from C++!" << endl;
    int total = 0;
    for (int i = 1; i <= 10; i++) {
        total += i * i;
    }
    cout << "sum of squares 1..10 = " << total << endl;
    double r = 2.5;
    cout << "circle area (r=2.5) = " << 3.14159265 * r * r << endl;
    return 0;
}
