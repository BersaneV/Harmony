use std::{fs::File, io, path::Path};

/// The server/worker run on Linux (macOS is supported for local development).
/// Every child operation is *at relative to this directory descriptor. Flat
/// hashed names prevent traversal and O_NOFOLLOW rejects filesystem symlinks.
pub struct Local {
    directory: File,
}

#[cfg(unix)]
impl Local {
    pub fn new(path: &Path) -> io::Result<Self> {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        std::fs::create_dir_all(path)?;
        let directory = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?;
        directory.set_permissions(std::fs::Permissions::from_mode(0o700))?;
        Ok(Self { directory })
    }
    fn name(name: &str) -> io::Result<std::ffi::CString> {
        if name.is_empty()
            || name.contains('/')
            || name.contains('\\')
            || name == "."
            || name == ".."
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid local name",
            ));
        }
        std::ffi::CString::new(name)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid local name"))
    }
    fn open_flags(&self, name: &str, flags: i32) -> io::Result<File> {
        use std::os::fd::{AsRawFd, FromRawFd};
        let name = Self::name(name)?;
        // SAFETY: directory owns a live directory fd, name is NUL-terminated;
        // a returned fd is immediately transferred into its sole File owner.
        let fd = unsafe {
            libc::openat(
                self.directory.as_raw_fd(),
                name.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
                0o600,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let meta = file.metadata()?;
        if !meta.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "object is not a regular file",
            ));
        }
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() != 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "object has unexpected hard links",
            ));
        }
        Ok(file)
    }
    pub fn open(&self, name: &str) -> io::Result<File> {
        self.open_flags(name, libc::O_RDONLY)
    }
    pub fn create(&self, name: &str) -> io::Result<File> {
        self.open_flags(name, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL)
    }
    pub fn publish(&self, from: &str, to: &str) -> io::Result<()> {
        use std::os::fd::AsRawFd;
        let from = Self::name(from)?;
        let to = Self::name(to)?;
        // renameat replaces a destination directory entry, never dereferencing
        // a symlink already present at that name.
        let status = unsafe {
            libc::renameat(
                self.directory.as_raw_fd(),
                from.as_ptr(),
                self.directory.as_raw_fd(),
                to.as_ptr(),
            )
        };
        if status < 0 {
            return Err(io::Error::last_os_error());
        }
        self.directory.sync_all()
    }
    pub fn remove(&self, name: &str) -> io::Result<()> {
        use std::os::fd::AsRawFd;
        let name = Self::name(name)?;
        let status = unsafe { libc::unlinkat(self.directory.as_raw_fd(), name.as_ptr(), 0) };
        if status < 0 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::NotFound {
                return Err(error);
            }
        }
        Ok(())
    }
    pub fn cleanup_staging(&self) -> io::Result<()> {
        use std::os::fd::AsRawFd;
        // A fresh open file description avoids sharing readdir's cursor with
        // another cleanup pass. fdopendir takes ownership of this new fd.
        let fd = unsafe {
            libc::openat(
                self.directory.as_raw_fd(),
                c".".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let dir = unsafe { libc::fdopendir(fd) };
        if dir.is_null() {
            unsafe {
                libc::close(fd);
            }
            return Err(io::Error::last_os_error());
        }
        struct Entries(*mut libc::DIR);
        impl Drop for Entries {
            fn drop(&mut self) {
                unsafe {
                    libc::closedir(self.0);
                }
            }
        }
        let entries = Entries(dir);
        loop {
            let entry = unsafe { libc::readdir(entries.0) };
            if entry.is_null() {
                break;
            }
            let name =
                unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) }.to_string_lossy();
            if !name.starts_with(".stage-") {
                continue;
            }
            if let Ok(file) = self.open(&name)
                && file.metadata()?.modified()?.elapsed().unwrap_or_default()
                    > std::time::Duration::from_secs(3600)
            {
                self.remove(&name)?;
            }
        }
        Ok(())
    }
}
