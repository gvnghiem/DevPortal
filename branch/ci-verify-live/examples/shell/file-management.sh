#!/bin/bash
# Copy, move, rename and clean up files — in a sandbox where mistakes are free.
cd ~
mkdir -p backup/2024 work
for n in a b c; do echo "file $n" > work/$n.txt; done
ls work

cp work/*.txt backup/2024/
mv work/c.txt work/c-renamed.txt
echo "--- after copy + move ---"
find work backup -name "*.txt" | sort

echo
echo "--- permissions ---"
touch run-me.sh
chmod +x run-me.sh
ls -l run-me.sh

echo
echo "--- delete (nothing outside the sandbox can be harmed) ---"
rm -r backup
ls
