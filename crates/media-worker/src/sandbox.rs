//! Restrict only the parser child. The supervising worker retains PG/S3 access.
//! No fallback to unsandboxed parsing is allowed.
use crate::{Config, Failure, Result};
use std::{path::Path, process::Stdio};
use tokio::process::Command;

pub fn command(config: &Config, executable: &Path, directory: &Path) -> Result<Command> {
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let escaped = |p: &Path| -> Result<String> {
            let s = p
                .to_str()
                .ok_or_else(|| Failure::permanent("sandbox_path"))?;
            if s.contains(['"', '\\', '\n']) {
                return Err(Failure::permanent("sandbox_path"));
            }
            Ok(s.to_owned())
        };
        let exe = escaped(executable)?;
        let dir = escaped(directory)?;
        let profile = format!(
            r#"(version 1)
(deny default)
(allow process-exec (literal "{exe}"))
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)
(allow file-read* (literal "/") (subpath "/System") (subpath "/usr/lib") (subpath "/Library/Apple") (literal "/dev/urandom") (literal "/dev/null") (literal "{exe}") (subpath "{dir}"))
(allow file-write* (subpath "{dir}") (literal "/dev/null"))
"#
        );
        let mut c = Command::new("/usr/bin/sandbox-exec");
        c.arg("-p").arg(profile).arg(executable);
        c
    };
    #[cfg(target_os = "linux")]
    let mut cmd = Command::new(executable);
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    return Err(Failure::permanent("sandbox_platform_unsupported"));
    cmd.env_clear()
        .env("LANG", "C")
        .env("LC_ALL", "C")
        .env("TMPDIR", directory)
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let cpu = config.timeout + 1;
    let memory = config.memory;
    let output = config.output_limit;
    #[cfg(target_os = "linux")]
    let paths = linux::prepare_paths(executable, directory)?;
    #[cfg(target_os = "linux")]
    let parent_pid = unsafe { libc::getpid() };
    // SAFETY: this closure performs only async-signal-safe libc syscalls after fork,
    // using precomputed paths/limits. Errors fail child creation instead of bypassing.
    unsafe {
        cmd.pre_exec(move || {
            if libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            limit(libc::RLIMIT_CPU as libc::c_int, cpu)?;
            limit(libc::RLIMIT_FSIZE as libc::c_int, output)?;
            limit(libc::RLIMIT_NOFILE as libc::c_int, 64)?;
            // macOS does not enforce RLIMIT_AS consistently; deployment also caps RSS via
            // the Linux container. The parent watchdog enforces macOS RSS (see parser).
            #[cfg(target_os = "linux")]
            {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0
                    || libc::getppid() != parent_pid
                {
                    return Err(std::io::Error::from_raw_os_error(libc::ECHILD));
                }
                limit(libc::RLIMIT_AS as libc::c_int, memory)?;
                linux::restrict(&paths)?;
            }
            #[cfg(target_os = "macos")]
            {
                let _ = memory;
            }
            Ok(())
        });
    }
    Ok(cmd)
}
#[cfg(unix)]
unsafe fn limit(resource: libc::c_int, value: u64) -> std::io::Result<()> {
    let limit = libc::rlimit {
        rlim_cur: value as libc::rlim_t,
        rlim_max: value as libc::rlim_t,
    };
    #[cfg(target_os = "linux")]
    let resource = resource as libc::__rlimit_resource_t;
    if unsafe { libc::setrlimit(resource, &limit) } != 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    // Stable Linux UAPI: Landlock ABI3 handles truncate and cross-directory refer.
    const FS_ALL: u64 = (1 << 15) - 1;
    const READ: u64 = (1 << 0) | (1 << 2) | (1 << 3);
    const WRITE: u64 = (1 << 1) | (1 << 4) | (1 << 5) | (1 << 7) | (1 << 8) | (1 << 13) | (1 << 14);
    #[repr(C)]
    struct Ruleset {
        handled_access_fs: u64,
    }
    #[repr(C, packed)]
    struct PathBeneath {
        allowed_access: u64,
        parent_fd: i32,
    }
    pub fn prepare_paths(exe: &Path, dir: &Path) -> Result<Vec<(CString, u64)>> {
        let mut paths = Vec::new();
        for (p, rights) in [
            (Path::new("/usr"), READ),
            (Path::new("/lib"), READ),
            (Path::new("/lib64"), READ),
            (Path::new("/etc/ld.so.cache"), 1 << 2),
            (Path::new("/dev/null"), (1 << 1) | (1 << 2)),
            (Path::new("/dev/urandom"), 1 << 2),
            (exe, (1 << 0) | (1 << 2)),
            (dir, READ | WRITE),
        ] {
            if p.exists() {
                let actual = p.canonicalize()?;
                paths.push((
                    CString::new(actual.as_os_str().as_bytes())
                        .map_err(|_| Failure::permanent("sandbox_path"))?,
                    rights,
                ));
            }
        }
        Ok(paths)
    }
    pub unsafe fn restrict(paths: &[(CString, u64)]) -> std::io::Result<()> {
        unsafe {
            let fail = || std::io::Error::last_os_error();
            let abi = libc::syscall(
                libc::SYS_landlock_create_ruleset,
                std::ptr::null::<u8>(),
                0,
                1,
            );
            if abi < 3 {
                return Err(std::io::Error::from_raw_os_error(libc::ENOTSUP));
            }
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                return Err(fail());
            }
            let attr = Ruleset {
                handled_access_fs: FS_ALL,
            };
            let fd = libc::syscall(
                libc::SYS_landlock_create_ruleset,
                &attr,
                std::mem::size_of::<Ruleset>(),
                0,
            ) as i32;
            if fd < 0 {
                return Err(fail());
            }
            for (path, rights) in paths {
                let parent = libc::open(path.as_ptr(), libc::O_PATH | libc::O_CLOEXEC);
                if parent < 0 {
                    libc::close(fd);
                    return Err(fail());
                }
                let rule = PathBeneath {
                    allowed_access: *rights,
                    parent_fd: parent,
                };
                let result = libc::syscall(libc::SYS_landlock_add_rule, fd, 1, &rule, 0);
                libc::close(parent);
                if result != 0 {
                    libc::close(fd);
                    return Err(fail());
                }
            }
            let result = libc::syscall(libc::SYS_landlock_restrict_self, fd, 0);
            libc::close(fd);
            if result != 0 {
                return Err(fail());
            }
            seccomp()
        }
    }
    unsafe fn seccomp() -> std::io::Result<()> {
        unsafe {
            #[cfg(target_arch = "x86_64")]
            const ARCH: u32 = 0xc000003e;
            #[cfg(target_arch = "aarch64")]
            const ARCH: u32 = 0xc00000b7;
            // Check architecture first: an x86 compat syscall number must not bypass policy.
            let mut filters = [libc::sock_filter {
                code: 0,
                jt: 0,
                jf: 0,
                k: 0,
            }; 96];
            let mut n = 0usize;
            let mut push = |code, jt, jf, k| {
                filters[n] = libc::sock_filter { code, jt, jf, k };
                n += 1;
            };
            push(0x20, 0, 0, 4);
            push(0x15, 1, 0, ARCH);
            push(0x06, 0, 0, 0x80000000);
            push(0x20, 0, 0, 0);
            #[cfg(target_arch = "x86_64")]
            {
                push(0x35, 0, 1, 0x40000000);
                push(0x06, 0, 0, 0x80000000);
            }
            // Permit pthread clone only, never process forks. clone3 falls back to
            // clone in libc; its indirect argument structure cannot be filtered here.
            push(0x15, 0, 4, libc::SYS_clone as u32);
            push(0x20, 0, 0, 16);
            push(0x45, 1, 0, libc::CLONE_THREAD as u32);
            push(0x06, 0, 0, 0x00050000 | libc::EPERM as u32);
            push(0x06, 0, 0, 0x7fff0000);
            push(0x15, 0, 1, libc::SYS_clone3 as u32);
            push(0x06, 0, 0, 0x00050000 | libc::ENOSYS as u32);
            #[cfg(target_arch = "x86_64")]
            for syscall in [libc::SYS_fork, libc::SYS_vfork] {
                push(0x15, 0, 1, syscall as u32);
                push(0x06, 0, 0, 0x00050000 | libc::EPERM as u32);
            }
            for syscall in [
                libc::SYS_socket,
                libc::SYS_socketpair,
                libc::SYS_connect,
                libc::SYS_bind,
                libc::SYS_listen,
                libc::SYS_accept,
                libc::SYS_accept4,
                libc::SYS_sendto,
                libc::SYS_sendmsg,
                libc::SYS_recvfrom,
                libc::SYS_recvmsg,
                libc::SYS_ptrace,
                libc::SYS_process_vm_readv,
                libc::SYS_process_vm_writev,
                libc::SYS_mount,
                libc::SYS_umount2,
                libc::SYS_unshare,
                libc::SYS_setns,
                libc::SYS_bpf,
                libc::SYS_keyctl,
                libc::SYS_io_uring_setup,
                libc::SYS_open_by_handle_at,
                libc::SYS_kill,
                libc::SYS_tkill,
                libc::SYS_tgkill,
            ] {
                push(0x15, 0, 1, syscall as u32);
                push(0x06, 0, 0, 0x00050000 | libc::EPERM as u32);
            }
            push(0x06, 0, 0, 0x7fff0000);
            let program = libc::sock_fprog {
                len: n as u16,
                filter: filters.as_mut_ptr(),
            };
            if libc::prctl(libc::PR_SET_SECCOMP, 2, &program) != 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        }
    }
}
