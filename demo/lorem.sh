#!/bin/sh
# Fill the current terminal with lorem ipsum, for README screenshots.
#
#   sh demo/lorem.sh            # size from the terminal (run it inside the rail)
#   sh demo/lorem.sh 43 96      # explicit rows and columns
#
# Prints rows-2 lines, each at most cols-1 wide, so nothing scrolls and nothing
# auto-wraps: the text fills the pane and the shell prompt stays visible below it.

# `stty size` reads the tty on stdin. `tput` inside $(...) has no tty on stdout
# and silently falls back to 24x80, so don't use it for the size.
size=$(stty size 2>/dev/null)
rows=${1:-${size% *}}
cols=${2:-${size#* }}
rows=${rows:-24}
cols=${cols:-80}

paragraphs() {
  cat <<'EOF'
Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.

Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.

Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.

Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt.

EOF
}

# Repeat enough paragraphs to cover any realistic screen, wrap on word
# boundaries, then cut to exactly the number of lines that fit.
i=0
while [ "$i" -lt 40 ]; do
  paragraphs
  i=$((i + 1))
done | fold -s -w $((cols - 1)) | head -n $((rows - 2))
