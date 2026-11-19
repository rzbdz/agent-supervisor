# Running instance

- URL (tailnet): http://100.101.224.37:4720/
- URL (MagicDNS): http://lt-panjunzhong.tail4f23f7.ts.net:4720/
- URL (LAN): http://172.22.50.37:4720/
- Workdir: /root/agent-supervisor
- State: /root/agent-supervisor/.supervisor
- Log: /tmp/supervisor-daemon.log

Started with:

```bash
node --import tsx packages/server/src/main.ts \
  --port 4720 --root /root/agent-supervisor --host 0.0.0.0
```

The bind is `0.0.0.0`, so anyone who can reach this host on the tailnet or
the LAN can open the panel and answer decisions. Stop it with `pnpm sv down`
or `POST /api/admin/shutdown`.
