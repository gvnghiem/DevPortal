// C++ (subset simulator): tic-tac-toe, two simple bots play each other.
#include <iostream>
using namespace std;

char board[9];

void show() {
    for (int r = 0; r < 3; r++) {
        cout << " " << board[r*3] << " | " << board[r*3+1] << " | " << board[r*3+2] << endl;
        if (r < 2) cout << "---+---+---" << endl;
    }
    cout << endl;
}

int winner() {
    int w[8][3] = {{0,1,2},{3,4,5},{6,7,8},{0,3,6},{1,4,7},{2,5,8},{0,4,8},{2,4,6}};
    for (int i = 0; i < 8; i++)
        if (board[w[i][0]] != ' ' && board[w[i][0]] == board[w[i][1]] && board[w[i][1]] == board[w[i][2]]) return 1;
    return 0;
}

// first try to win, then block, then centre, corners, edges
int pick(char me, char other) {
    int w[8][3] = {{0,1,2},{3,4,5},{6,7,8},{0,3,6},{1,4,7},{2,5,8},{0,4,8},{2,4,6}};
    for (int pass = 0; pass < 2; pass++) {
        char who = pass == 0 ? me : other;
        for (int i = 0; i < 8; i++) {
            int cnt = 0, empty = -1;
            for (int k = 0; k < 3; k++) {
                int c = w[i][k];
                if (board[c] == who) cnt++;
                else if (board[c] == ' ') empty = c;
            }
            if (cnt == 2 && empty >= 0) return empty;
        }
    }
    int order[9] = {4, 0, 2, 6, 8, 1, 3, 5, 7};
    for (int i = 0; i < 9; i++) if (board[order[i]] == ' ') return order[i];
    return -1;
}

int main() {
    for (int i = 0; i < 9; i++) board[i] = ' ';
    char turn = 'X';
    for (int move = 0; move < 9; move++) {
        char other = turn == 'X' ? 'O' : 'X';
        int c = pick(turn, other);
        board[c] = turn;
        cout << "Move " << move + 1 << ": " << turn << " plays square " << c + 1 << endl;
        if (winner()) { show(); cout << turn << " wins!" << endl; return 0; }
        turn = other;
    }
    show();
    cout << "It's a draw." << endl;
    return 0;
}
