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

// Tracks which testers are "manning" a queue right now — set as soon as
// /postqueue is run (by whoever ran it) or someone runs /jointesting.
// When "Next" pulls someone, every tester in this set gets access to the
// resulting ticket automatically, not just whoever clicked the button.
const queueTesters = new Map(); // queueKey -> Set of userIds

function addQueueTester(queueKey, userId) {
  if (!queueTesters.has(queueKey)) queueTesters.set(queueKey, new Set());
  const set = queueTesters.get(queueKey);
  if (set.has(userId)) return false; // already a tester here
  set.add(userId);
  return true;
}

function getQueueTesters(queueKey) {
  return Array.from(queueTesters.get(queueKey) || []);
}

// Tracks the message ID of the currently-posted queue embed for each queue
// key, so commands like /jointesting (which aren't a click on that message)
// can still find and refresh it.
const queueMessages = new Map(); // queueKey -> { channelId, messageId }

function setQueueMessage(queueKey, channelId, messageId) {
  queueMessages.set(queueKey, { channelId, messageId });
}

function getQueueMessage(queueKey) {
  return queueMessages.get(queueKey) || null;
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
  addQueueTester,
  getQueueTesters,
  setQueueMessage,
  getQueueMessage,
};
