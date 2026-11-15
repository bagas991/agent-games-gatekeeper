#!/bin/bash
cd /root/agent-games
pkill -f 'node src/agent.js' 2>/dev/null
sleep 1
AGENT_GAMES_HMAC_SECRET=placeholder PORT=8443 nohup node src/agent.js > agent.log 2>&1 &
echo "AGENT_PID=$!"
sleep 2
cat agent.log
echo "---HEALTH---"
curl -s http://127.0.0.1:8443/health
echo
