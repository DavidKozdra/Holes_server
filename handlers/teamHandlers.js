const { savePlayerSnapshot, queueWorldSave } = require('../utils/playerUtils');

function register(socket, ctx) {
  const { io, players, teams } = ctx;

  socket.on('create_team', (data) => {
    const { name, color } = data;
    const playerData = players[socket.id];
    if (!playerData || !playerData.name) return;

    const teamId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    teams[teamId] = {
      id: teamId, name, color,
      creator: playerData.name,
      leaders: [playerData.name],
      members: [playerData.name],
      requests: []
    };

    playerData.teamId = teamId;
    playerData.color = { r: color.r, g: color.g, b: color.b };

    io.emit('TEAM_CREATED', { teamId, team: teams[teamId] });
    io.emit('TEAMS_UPDATE', { teams });
    queueWorldSave('team-create');
    savePlayerSnapshot(playerData);
    socket.emit('TEAM_JOINED', { teamId, team: teams[teamId] });
  });

  socket.on('request_join_team', (data) => {
    const { teamId } = data;
    const playerData = players[socket.id];
    if (!playerData || !playerData.name || !teams[teamId]) return;

    if (playerData.teamId) {
      socket.emit('TEAM_ERROR', { message: 'Already in a team. Leave your current team first.' });
      return;
    }
    if (teams[teamId].requests.includes(playerData.name)) {
      socket.emit('TEAM_ERROR', { message: 'Already requested to join this team.' });
      return;
    }

    teams[teamId].requests.push(playerData.name);
    queueWorldSave('team-request');

    const creatorSocketId = Object.keys(players).find(id => players[id].name === teams[teamId].creator);
    if (creatorSocketId) {
      io.to(creatorSocketId).emit('TEAM_REQUEST', { teamId, playerName: playerData.name });
    }
    socket.emit('TEAM_REQUEST_SENT', { teamId });
  });

  socket.on('accept_team_request', (data) => {
    const { teamId, playerName } = data;
    const team = teams[teamId];
    const playerSocketId = Object.keys(players).find(id => players[id].name === playerName);
    const playerData = playerSocketId ? players[playerSocketId] : null;
    if (!team || !playerData || !playerName) return;

    const requesterData = players[socket.id];
    if (!requesterData || team.creator !== requesterData.name) {
      socket.emit('TEAM_ERROR', { message: 'Only team creator can accept requests.' });
      return;
    }

    team.requests = team.requests.filter(name => name !== playerName);
    team.members.push(playerName);
    playerData.teamId = teamId;
    playerData.color = { r: team.color.r, g: team.color.g, b: team.color.b };

    queueWorldSave('team-accept');
    savePlayerSnapshot(playerData);

    io.emit('TEAMS_UPDATE', { teams });
    io.emit('PLAYER_COLOR_CHANGED', { playerId: playerSocketId, color: playerData.color });
    io.to(playerSocketId).emit('TEAM_JOINED', { teamId, team });
  });

  socket.on('deny_team_request', (data) => {
    const { teamId, playerName } = data;
    const team = teams[teamId];
    const playerSocketId = Object.keys(players).find(id => players[id].name === playerName);
    if (!team || !playerName) return;

    const requesterData = players[socket.id];
    if (!requesterData || team.creator !== requesterData.name) return;

    team.requests = team.requests.filter(name => name !== playerName);
    queueWorldSave('team-deny');

    if (playerSocketId) {
      io.to(playerSocketId).emit('TEAM_REQUEST_DENIED', { teamId });
    }
  });

  socket.on('leave_team', () => {
    const playerData = players[socket.id];
    if (!playerData || !playerData.teamId || !playerData.name) return;

    const teamId = playerData.teamId;
    const team = teams[teamId];
    if (!team) return;

    team.members = team.members.filter(name => name !== playerData.name);
    team.leaders = team.leaders.filter(name => name !== playerData.name);
    playerData.teamId = null;
    playerData.color = 0;

    if (team.creator === playerData.name) {
      team.members.forEach(memberName => {
        const memberSocketId = Object.keys(players).find(id => players[id].name === memberName);
        if (memberSocketId) {
          players[memberSocketId].teamId = null;
          players[memberSocketId].color = 0;
          savePlayerSnapshot(players[memberSocketId]);
          io.to(memberSocketId).emit('TEAM_DISBANDED', { teamId });
        }
      });
      delete teams[teamId];
    }

    queueWorldSave('team-leave');
    savePlayerSnapshot(playerData);

    io.emit('TEAMS_UPDATE', { teams });
    io.emit('PLAYER_COLOR_CHANGED', { playerId: socket.id, color: playerData.color });
    socket.emit('TEAM_LEFT', { teamId });
  });

  socket.on('update_team', (data) => {
    const { teamId, name, color } = data;
    const team = teams[teamId];
    const requesterData = players[socket.id];
    if (!team || !requesterData) return;

    if (team.creator !== requesterData.name && !team.leaders.includes(requesterData.name)) {
      socket.emit('TEAM_ERROR', { message: 'Only team leaders can update team.' });
      return;
    }

    if (name) team.name = name;
    if (color) {
      team.color = color;
      team.members.forEach(memberName => {
        const memberSocketId = Object.keys(players).find(id => players[id].name === memberName);
        if (memberSocketId && players[memberSocketId]) {
          players[memberSocketId].color = { r: color.r, g: color.g, b: color.b };
          savePlayerSnapshot(players[memberSocketId]);
        }
      });
    }

    queueWorldSave('team-update');
    io.emit('TEAMS_UPDATE', { teams });
  });

  socket.on('get_teams', () => {
    socket.emit('TEAMS_UPDATE', { teams });
  });

  socket.on('promote_member', (data) => {
    const { teamId, memberName } = data;
    const team = teams[teamId];
    const requesterData = players[socket.id];
    if (!team || !requesterData || !memberName) return;

    if (!team.leaders.includes(requesterData.name)) {
      socket.emit('TEAM_ERROR', { message: 'Only team leaders can promote members.' });
      return;
    }
    if (!team.members.includes(memberName)) {
      socket.emit('TEAM_ERROR', { message: 'Member not found in team.' });
      return;
    }
    if (!team.leaders.includes(memberName)) {
      team.leaders.push(memberName);
    }

    queueWorldSave('team-promote');
    io.emit('TEAMS_UPDATE', { teams });
  });

  socket.on('remove_member', (data) => {
    const { teamId, memberName } = data;
    const team = teams[teamId];
    const memberSocketId = Object.keys(players).find(id => players[id].name === memberName);
    const memberData = memberSocketId ? players[memberSocketId] : null;
    const requesterData = players[socket.id];
    if (!team || !requesterData || !memberName) return;

    if (!team.leaders.includes(requesterData.name)) {
      socket.emit('TEAM_ERROR', { message: 'Only team leaders can remove members.' });
      return;
    }
    if (team.leaders.includes(memberName)) {
      socket.emit('TEAM_ERROR', { message: 'Cannot remove a team leader. Promote them to regular member first.' });
      return;
    }

    team.members = team.members.filter(name => name !== memberName);
    if (memberData && memberSocketId) {
      memberData.teamId = null;
      memberData.color = 0;
      savePlayerSnapshot(memberData);
      io.to(memberSocketId).emit('TEAM_MEMBER_REMOVED', { teamId });
    }

    queueWorldSave('team-remove');
    io.emit('TEAMS_UPDATE', { teams });
  });

  socket.on('invite_player', (data) => {
    const { teamId, invitedPlayerName } = data;
    const team = teams[teamId];
    const requesterData = players[socket.id];
    const invitedPlayerSocketId = Object.keys(players).find(id => players[id].name === invitedPlayerName);
    const invitedPlayer = invitedPlayerSocketId ? players[invitedPlayerSocketId] : null;
    if (!team || !requesterData || !invitedPlayerName || !invitedPlayer) return;

    if (!team.leaders.includes(requesterData.name)) {
      socket.emit('TEAM_ERROR', { message: 'Only team leaders can invite players.' });
      return;
    }
    if (invitedPlayer.teamId) {
      socket.emit('TEAM_ERROR', { message: 'That player is already in a team.' });
      return;
    }

    io.to(invitedPlayerSocketId).emit('TEAM_INVITE', {
      teamId, teamName: team.name, inviterName: requesterData.name
    });
    socket.emit('TEAM_INVITE_SENT', { playerName: invitedPlayerName });
  });

  socket.on('accept_invite', (data) => {
    const { teamId } = data;
    const playerData = players[socket.id];
    const team = teams[teamId];
    if (!playerData || !playerData.name || !team) return;

    if (playerData.teamId) {
      socket.emit('TEAM_ERROR', { message: 'You are already in a team.' });
      return;
    }

    team.members.push(playerData.name);
    playerData.teamId = teamId;
    playerData.color = { r: team.color.r, g: team.color.g, b: team.color.b };

    queueWorldSave('team-accept-invite');
    savePlayerSnapshot(playerData);

    io.emit('TEAMS_UPDATE', { teams });
    io.emit('PLAYER_COLOR_CHANGED', { playerId: socket.id, color: playerData.color });
    socket.emit('TEAM_JOINED', { teamId, team });
  });

  socket.on('decline_invite', (data) => {
    const { teamId } = data;
    socket.emit('TEAM_INVITE_DECLINED', { teamId });
  });
}

module.exports = { register };
