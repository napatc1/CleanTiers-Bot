// One queue array per channel ID. Lives in memory only — clears on restart,
// which is fine since a queue only makes sense while the bot is live anyway.
const queues = new Map();

// Tracks which queue keys are currently closed to new joins.
const closedQueues = new Set();

function getQueue(channelId) {
  if (!queues.has(channelId)) queues.set(channelId, []);
  return queues.get(channelId);
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
};
