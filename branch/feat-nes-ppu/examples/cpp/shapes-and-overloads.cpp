// C++ (subset simulator): functions, references-free math, loops.
#include <iostream>
#include <iomanip>
#include <cmath>
using namespace std;

double circleArea(double r) { return 3.14159265358979 * r * r; }
double rectArea(double w, double h) { return w * h; }
double triArea(double a, double b, double c) {
    double s = (a + b + c) / 2;
    return sqrt(s * (s - a) * (s - b) * (s - c));
}

int main() {
    cout << fixed << setprecision(3);
    cout << "circle r=2.5   : " << circleArea(2.5) << endl;
    cout << "rect 3x4.5     : " << rectArea(3, 4.5) << endl;
    cout << "triangle 3-4-5 : " << triArea(3, 4, 5) << endl;

    cout << endl << "Multiplication table" << endl;
    for (int i = 1; i <= 5; i++) {
        for (int j = 1; j <= 5; j++) cout << setw(4) << i * j;
        cout << endl;
    }

    cout << endl << "Fibonacci:";
    int a = 0, b = 1;
    for (int i = 0; i < 12; i++) {
        cout << " " << a;
        int t = a + b; a = b; b = t;
    }
    cout << endl;
    return 0;
}
