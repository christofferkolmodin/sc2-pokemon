# Hosting on a Hetzner VPS

Moves pokecraft.party (and pokecraft.win) off this PC onto a small always-on server. The setup stays the same as on the PC: Node runs the game, and the Cloudflare Tunnel connects it to the domain. The server needs no open ports except SSH, and the PC can be off.

```
friends ──HTTPS──▶ Cloudflare ◀══ tunnel ══ cloudflared (VPS) ──▶ 127.0.0.1:3000 (sc2-pokemon service)
```

Where the files come from:

| What | How it gets to the server |
|---|---|
| Code | `git clone` / `git pull` from GitHub (read-only deploy key) |
| `node_modules/`, `dist/` | Built on the server (`npm ci`, `npm start`) |
| `assets-private/`, `.game-password` | Copied from the PC with `scp`; never in git |
| Tunnel credentials | Copied from `~/.cloudflared/` on the PC |

Budget about 30 minutes. Commands in `PS>` blocks run in PowerShell on the PC; everything else runs on the server.

## 0. Before you start

Commit and push everything you want live. The server only gets what's on GitHub.

```powershell
PS> cd D:\projects\repos\sc2-pokemon
PS> git status
PS> git push
```

If you don't have an SSH key on the PC yet (`C:\Users\Chris\.ssh\id_ed25519.pub` missing), make one:

```powershell
PS> ssh-keygen -t ed25519
PS> Get-Content ~\.ssh\id_ed25519.pub   # copy this line for step 1
```

## 1. Create the server

In the [Hetzner Cloud console](https://console.hetzner.cloud): **New project → Add server**.

- **Location:** closest to you and your friends (lockstep waits for the slowest player).
- **Image:** Ubuntu 24.04.
- **Type:** the cheapest shared x86 plan (CX23 or similar). ARM (CAX) works too, but then use the `arm64` cloudflared package in step 5.
- **SSH key:** paste the `.pub` line from step 0.
- **Firewall:** create one that allows inbound **TCP 22 (SSH) only**. The tunnel connects outwards, so no web ports are needed.

Note the server's IPv4 address, then connect:

```powershell
PS> ssh root@<server-ip>
```

## 2. Install Node and create the app user

```bash
apt-get update && apt-get upgrade -y
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs git
node -v                      # needs 20.11 or newer

adduser --disabled-password --gecos "" game
```

The game runs as the unprivileged `game` user, not root.

## 3. Get the code from GitHub

Make a deploy key for the `game` user:

```bash
sudo -iu game
ssh-keygen -t ed25519 -C "pokecraft vps" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

On GitHub: **sc2-pokemon → Settings → Deploy keys → Add deploy key**. Paste the line, leave **Allow write access** off.

Then, still as `game`:

```bash
git clone git@github.com:christofferkolmodin/sc2-pokemon.git   # answer "yes" to the host key prompt
cd sc2-pokemon
npm ci
npm run build
exit                         # back to root
```

## 4. Copy the private files from the PC

```powershell
PS> cd D:\projects\repos\sc2-pokemon
PS> scp -r assets-private root@<server-ip>:/home/game/sc2-pokemon/
PS> scp .game-password root@<server-ip>:/home/game/sc2-pokemon/
```

Back on the server, give them to the `game` user:

```bash
chown -R game:game /home/game/sc2-pokemon/assets-private /home/game/sc2-pokemon/.game-password
chmod 600 /home/game/sc2-pokemon/.game-password
```

Repeat the `scp` whenever you add maps, sounds or other assets on the PC. No restart is needed: the server reads the map and sound lists fresh on every request.

## 5. Start the game as a service

```bash
cp /home/game/sc2-pokemon/tools/server/sc2-pokemon.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now sc2-pokemon
systemctl status sc2-pokemon          # should say "active (running)"
curl -I http://127.0.0.1:3000/        # should answer 200
```

The service binds to `127.0.0.1`, so only cloudflared on the same machine can reach it, and it restarts automatically after crashes and reboots.

## 6. Move the Cloudflare Tunnel

Install cloudflared:

```bash
curl -fsSL -o /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
dpkg -i /tmp/cloudflared.deb          # ARM server: cloudflared-linux-arm64.deb
mkdir -p /etc/cloudflared
```

Copy the tunnel config and credentials from the PC (not `cert.pem`, which is only needed to create tunnels or change DNS):

```powershell
PS> scp $HOME\.cloudflared\config.yml $HOME\.cloudflared\742f8d14-80c3-4fc3-928d-7722ac62a6d5.json root@<server-ip>:/etc/cloudflared/
```

On the server, point `credentials-file` at the new location:

```bash
sed -i 's|^credentials-file:.*|credentials-file: /etc/cloudflared/742f8d14-80c3-4fc3-928d-7722ac62a6d5.json|' /etc/cloudflared/config.yml
chmod 600 /etc/cloudflared/*.json
cat /etc/cloudflared/config.yml       # ingress should still map both domains to http://localhost:3000
```

**Stop the tunnel on the PC first.** If both run at once, Cloudflare splits visitors between the PC and the server, and friends end up in different lobbies. Close the `cloudflared tunnel run pokecraft` window on the PC (or stop the process in Task Manager), then on the server:

```bash
cloudflared service install
systemctl status cloudflared          # should say "active (running)"
```

DNS doesn't change: it's the same tunnel, now running from the server.

## 7. Check it

- Open https://pokecraft.party on your phone (not on wifi, to be sure it isn't the PC answering). You should get the password page.
- Shut down the PC and check again.
- Optional: reboot the server (`reboot`) and confirm both services come back on their own.

## Updating the game

Push from the PC, then run the update script on the server:

```powershell
PS> git push
PS> ssh -t root@<server-ip> bash /home/game/sc2-pokemon/tools/server/update.sh
```

It pulls, installs packages, builds, and asks before restarting (a restart ends any match in progress). If the build fails, the running server is left untouched. Add `--yes` to skip the question.

## Handy commands

| Task | Command (on the server) |
|---|---|
| Game log, live | `journalctl -u sc2-pokemon -f` |
| Tunnel log | `journalctl -u cloudflared -n 50` |
| Restart the game | `systemctl restart sc2-pokemon` |
| Change the password | edit `/home/game/sc2-pokemon/.game-password`, then restart (logs everyone out) |
| OS updates | `apt-get update && apt-get upgrade -y` now and then |

To play on the server without the password (it skips localhost), forward the port over SSH and open http://localhost:3000:

```powershell
PS> ssh -L 3000:127.0.0.1:3000 root@<server-ip>
```

Stop any local `npm start` on the PC first, since it uses the same port.

## Going back to the PC

Stop the tunnel on the server (`systemctl stop cloudflared`) and run `cloudflared tunnel run pokecraft` on the PC again.
