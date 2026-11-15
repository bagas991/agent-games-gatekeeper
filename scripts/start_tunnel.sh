#!/bin/bash
pkill -f 'cloudflared tunnel' 2>/dev/null
sleep 1
nohup cloudflared tunnel --url http://127.0.0.1:8443 > /root/agent-games/tunnel.log 2>&1 &
echo "TUNNEL_PID=$!"
sleep 10
echo "---TUNNEL LOG---"
cat /root/agent-games/tunnel.log
echo "---URL---"
grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /root/agent-games/tunnel.log | head -1
