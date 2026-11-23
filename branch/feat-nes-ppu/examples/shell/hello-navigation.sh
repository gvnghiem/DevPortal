#!/bin/bash
# Welcome to the shell playground — a SAFE, simulated Linux shell.
# Nothing here touches your computer: the files live in a virtual filesystem.
echo "Hello from $(whoami) on $(uname -s)!"
echo "I am in: $(pwd)"

echo
echo "--- what is in my home folder? ---"
ls -la

echo
echo "--- peek at a file ---"
cat notes.txt

echo
echo "--- make a folder, step into it, create a file ---"
mkdir -p playground/deep/er
cd playground
echo "first line" > hello.txt
echo "second line" >> hello.txt
cat hello.txt
wc -l hello.txt

echo
echo "--- the whole tree ---"
cd ~
tree
