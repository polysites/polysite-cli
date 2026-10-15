# Polysite CLI installer for Windows: NOT IMPLEMENTED YET (v0.1 TODO).
#
# The CLI itself is plain Node.js and works on Windows, and docker compose is driven without a shell, so until this
# script exists install it with npm once the package is published:
#
#   npm install --global @polysite/cli
#
# or from a release tarball:
#
#   npm install --global .\polysite-cli-0.1.0.tgz
#
# TODO: mirror install.sh: check Node 22+, download the tarball and its .sha256 over HTTPS, verify with
# Get-FileHash -Algorithm SHA256, unpack into $env:LOCALAPPDATA\polysite-cli\<version>, and write polysite.cmd,
# polysites.cmd and poly.cmd into a folder added to the user PATH.
Write-Error "install.ps1 is not implemented yet. Use: npm install --global @polysite/cli"
exit 1
