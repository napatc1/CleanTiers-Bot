// One queue array per channel ID. Lives in memory only — clears on restart,
// which is fine since a queue only makes sense while the bot is live anyway.
const queues = new Map();

// Tracks which queue keys are currently closed to new joins.
const closedQueues = new Set();

function getQueue(channelId) {
  if (!queues.has(channelId)) queues.set(channelId, []);
  return queues.get(channelId);
}

// Tracks the current in-progress test per queue key, so the queue message
// can show "Currently testing" and /jointesting knows which ticket to add
// a second tester to. Cleared when the ticket closes.
const activeTesting = new Map(); // queueKey -> { ticketChannelId, testerId, testeeId, queueChannelId, queueMessageId, gamemode, isHigh }
const ticketToQueueKey = new Map(); // ticketChannelId -> queueKey

function setActiveTesting(queueKey, info) {
  activeTesting.set(queueKey, info);
  ticketToQueueKey.set(info.ticketChannelId, queueKey);
}

function getActiveTesting(queueKey) {
  return activeTesting.get(queueKey) || null;
}

// Call when a ticket closes. Returns the removed record (or null) so the
// caller can go refresh that queue's message.
function clearActiveTestingByTicket(ticketChannelId) {
  const queueKey = ticketToQueueKey.get(ticketChannelId);
  if (!queueKey) return null;
  const info = activeTesting.get(queueKey) || null;
  activeTesting.delete(queueKey);
  ticketToQueueKey.delete(ticketChannelId);
  return info;
}

function getActiveTestingByTicket(ticketChannelId) {
  const queueKey = ticketToQueueKey.get(ticketChannelId);
  return queueKey ? activeTesting.get(queueKey) : null;
}

function isQueueClosed(key) {
  return closedQueues.has(key);
}

function setQueueClosed(key, closed) {
  if (closed) closedQueues.add(key);
  else closedQueues.delete(key);
}

function joinQueue(channelId, userId) {
  const queue = getQueue(channelId);
  if (queue.includes(userId)) return false; // already in queue
  queue.push(userId);
  return true;
}

function leaveQueue(channelId, userId) {
  const queue = getQueue(channelId);
  const index = queue.indexOf(userId);
  if (index === -1) return false; // wasn't in queue
  queue.splice(index, 1);
  return true;
}

// Removes and returns the first person in line, or null if empty.
function popNext(channelId) {
  const queue = getQueue(channelId);
  return queue.length ? queue.shift() : null;
}

function formatQueue(channelId) {
  const queue = getQueue(channelId);
  if (queue.length === 0) return "_Queue is empty._";
  return queue.map((id, i) => `${i + 1}. <@${id}>`).join("\n");
}

module.exports = {
  joinQueue,
  leaveQueue,
  popNext,
  formatQueue,
  getQueue,
  isQueueClosed,
  setQueueClosed,
  setActiveTesting,
  getActiveTesting,
  clearActiveTestingByTicket,
  getActiveTestingByTicket,
};
