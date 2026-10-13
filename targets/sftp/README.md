# SFTP server

Any machine you can reach over SSH: a NAS, a friend's server, a rented box. Make an SSH key without a
passphrase (`ssh-keygen -t ed25519 -N '' -f harbor-backup`), put `harbor-backup.pub` into
`~/.ssh/authorized_keys` of the account on the server, and paste the private key here. Leave **Server key**
empty and Harbor reads the key the server shows, then asks you to confirm its fingerprint (compare it with
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server) before it trusts it. You can also paste the
server key, or its `SHA256:…` fingerprint, yourself. Harbor pins the confirmed key and refuses a different one
afterwards. The server only ever stores encrypted pieces.
