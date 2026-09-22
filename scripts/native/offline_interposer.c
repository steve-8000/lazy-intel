#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <mach-o/dyld.h>
#include <mach-o/loader.h>
#include <mach-o/nlist.h>
#include <mach/mach.h>
#include <netdb.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

typedef struct { const void *replacement; const void *replacee; } interpose_entry;

typedef int (*connect_fn)(int, const struct sockaddr *, socklen_t);
typedef int (*socket_fn)(int, int, int);
typedef ssize_t (*sendto_fn)(int, const void *, size_t, int, const struct sockaddr *, socklen_t);
typedef int (*getaddrinfo_fn)(const char *, const char *, const struct addrinfo *, struct addrinfo **);

static connect_fn real_connect;
static socket_fn real_socket;
static sendto_fn real_sendto;
static getaddrinfo_fn real_getaddrinfo;
static pthread_once_t symbols_once = PTHREAD_ONCE_INIT;
static pthread_mutex_t log_mutex = PTHREAD_MUTEX_INITIALIZER;

static void resolve_symbols(void) {
  real_connect = (connect_fn)dlsym(RTLD_NEXT, "connect");
  real_socket = (socket_fn)dlsym(RTLD_NEXT, "socket");
  real_sendto = (sendto_fn)dlsym(RTLD_NEXT, "sendto");
  real_getaddrinfo = (getaddrinfo_fn)dlsym(RTLD_NEXT, "getaddrinfo");
}

static const char *events_path(void) {
  const char *path = getenv("LAZY_INTEL_OFFLINE_EVENTS");
  return (path && path[0]) ? path : NULL;
}

static void executable_path(char *out, size_t capacity) {
  uint32_t size = (uint32_t)capacity;
  if (_NSGetExecutablePath(out, &size) != 0) (void)snprintf(out, capacity, "unknown");
  out[capacity - 1] = '\0';
}

static void append_record(const char *kind, const char *operation, int family, int blocked, const char *host) {
  const char *path = events_path();
  if (!path) return;
  char executable[1024];
  executable_path(executable, sizeof(executable));
  struct timespec now;
  (void)clock_gettime(CLOCK_REALTIME, &now);
  long long time_ms = (long long)now.tv_sec * 1000LL + now.tv_nsec / 1000000LL;
  char line[4096];
  int length = snprintf(line, sizeof(line),
      "{\"kind\":\"%s\",\"operation\":\"%s\",\"pid\":%d,\"ppid\":%d,\"family\":%d,\"blocked\":%s,\"executable\":\"%s\"%s%s%s,\"timeMs\":%lld}\n",
      kind, operation, (int)getpid(), (int)getppid(), family,
      blocked ? "true" : "false", executable,
      host ? ",\"host\":\"" : "", host ? host : "", host ? "\"" : "", time_ms);
  if (length < 0 || (size_t)length >= sizeof(line)) return;
  pthread_mutex_lock(&log_mutex);
  int fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0600);
  if (fd >= 0) {
    (void)write(fd, line, (size_t)length);
    close(fd);
  }
  pthread_mutex_unlock(&log_mutex);
}

static int blocked_connect(int, const struct sockaddr *, socklen_t);
static ssize_t blocked_sendto(int, const void *, size_t, int, const struct sockaddr *, socklen_t);
static int blocked_getaddrinfo(const char *, const char *, const struct addrinfo *, struct addrinfo **);
extern int libc_socket(int, int, int) __asm__("_socket");

static int blocked_socket(int, int, int);

__attribute__((constructor)) static void offline_boot(void) {
  const char *path = events_path();
  if (!path) return;
  char executable[1024];
  executable_path(executable, sizeof(executable));
  char line[2048];
  int length = snprintf(line, sizeof(line),
      "{\"kind\":\"boot\",\"pid\":%d,\"ppid\":%d,\"executable\":\"%s\"}\n",
      (int)getpid(), (int)getppid(), executable);
  if (length <= 0 || (size_t)length >= sizeof(line)) return;
  int fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0600);
  if (fd >= 0) {
    (void)write(fd, line, (size_t)length);
    close(fd);
  }
}


static int blocked_socket(int domain, int type, int protocol) {
  pthread_once(&symbols_once, resolve_symbols);
  if (domain == AF_INET || domain == AF_INET6) {
    append_record("socket-open", "socket", domain, 0, NULL);
    return libc_socket(domain, type, protocol);
  }
  return real_socket ? real_socket(domain, type, protocol) : -1;
}

int socket_nocancel(int domain, int type, int protocol) __asm__("_socket$NOCANCEL");
int socket_nocancel(int domain, int type, int protocol) { return blocked_socket(domain, type, protocol); }

static int internet_family(const struct sockaddr *address) {
  if (!address) return 0;
  return address->sa_family == AF_INET || address->sa_family == AF_INET6;
}

static int deny_connect(int socket_fd, const struct sockaddr *address, socklen_t address_length);

static int blocked_connect(int socket_fd, const struct sockaddr *address, socklen_t address_length) {
  pthread_once(&symbols_once, resolve_symbols);
  return deny_connect(socket_fd, address, address_length);
}

static int deny_connect(int socket_fd, const struct sockaddr *address, socklen_t address_length) {
  if (internet_family(address)) {
    append_record("attempt", "connect$NOCANCEL", address->sa_family, 1, NULL);
    errno = EPERM;
    return -1;
  }
  return real_connect ? real_connect(socket_fd, address, address_length) : -1;
}

int connect_nocancel(int socket_fd, const struct sockaddr *address, socklen_t address_length) __asm__("_connect$NOCANCEL");
int connect_nocancel(int socket_fd, const struct sockaddr *address, socklen_t address_length) {
  pthread_once(&symbols_once, resolve_symbols);
  return deny_connect(socket_fd, address, address_length);
}

static ssize_t blocked_sendto(int socket_fd, const void *buffer, size_t length, int flags,
               const struct sockaddr *destination, socklen_t destination_length) {
  pthread_once(&symbols_once, resolve_symbols);
  if (internet_family(destination)) {
    append_record("attempt", "sendto", destination->sa_family, 1, NULL);
    errno = EPERM;
    return -1;
  }
  return real_sendto ? real_sendto(socket_fd, buffer, length, flags, destination, destination_length) : -1;
}


extern int libc_connect(int, const struct sockaddr *, socklen_t) __asm__("_connect");
extern ssize_t libc_sendto(int, const void *, size_t, int, const struct sockaddr *, socklen_t) __asm__("_sendto");
extern int libc_getaddrinfo(const char *, const char *, const struct addrinfo *, struct addrinfo **) __asm__("_getaddrinfo");
extern int libc_socket(int, int, int) __asm__("_socket");

__attribute__((used)) static const interpose_entry interpose_table[] __attribute__((section("__DATA,__interpose"))) = {
  { (const void *)blocked_connect, (const void *)libc_connect },
  { (const void *)blocked_socket, (const void *)libc_socket },
  { (const void *)blocked_sendto, (const void *)libc_sendto },
  { (const void *)blocked_getaddrinfo, (const void *)libc_getaddrinfo },
};

static int blocked_getaddrinfo(const char *node, const char *service, const struct addrinfo *hints, struct addrinfo **result) {
  pthread_once(&symbols_once, resolve_symbols);
  append_record("attempt", "getaddrinfo", hints ? hints->ai_family : AF_UNSPEC, 1, node);
  if (result) *result = NULL;
  return EAI_FAIL;
}
