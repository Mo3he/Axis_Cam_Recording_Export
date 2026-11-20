PROG = Recording_Export
SRCS = main.c
PKGS = glib-2.0

CFLAGS += -Wall -Wextra -Werror $(shell pkg-config --cflags $(PKGS))
LDFLAGS += -Wl,-z,noexecstack
LDLIBS += $(shell pkg-config --libs $(PKGS))

all: $(PROG)

$(PROG): $(SRCS)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $^ $(LDLIBS)

clean:
	rm -f $(PROG)
