// tsx uses process.geteuid() to name its temporary directory on POSIX and
// os.userInfo() on Windows. The restricted Windows test runner cannot query
// the OS account, so give child-process CLI tests the same non-secret numeric
// identity shape that tsx receives on POSIX.
if (typeof process.geteuid !== "function") {
  Object.defineProperty(process, "geteuid", {
    configurable: true,
    value: () => 1000,
  });
}
