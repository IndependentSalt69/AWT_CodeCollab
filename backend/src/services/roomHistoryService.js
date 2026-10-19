const mongoose = require('mongoose');
const Message = require('../../../database/models/Message');

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/**
 * Parses ?limit= and ?before= query values for cursor pagination.
 * Results are ordered newest first; `before` is the id of the oldest item
 * from the previous page.
 */
function parsePagination(query = {}) {
  let limit = DEFAULT_PAGE_SIZE;
  if (query.limit !== undefined) {
    limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      const error = new Error(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}`);
      error.status = 400;
      throw error;
    }
  }

  let before = null;
  if (query.before !== undefined) {
    if (typeof query.before !== 'string' || !/^[0-9a-f]{24}$/i.test(query.before)) {
      const error = new Error('before must be a valid message id');
      error.status = 400;
      throw error;
    }
    before = new mongoose.Types.ObjectId(query.before);
  }

  return { limit, before };
}

function buildPageQuery(roomId, before) {
  const query = { roomId };
  if (before) {
    query._id = { $lt: before };
  }
  return query;
}

function nextCursor(items, limit) {
  return items.length === limit ? items[items.length - 1].id : null;
}

/**
 * Lists persisted chat messages for a room, newest first.
 * Caller must have already verified room membership.
 */
async function listRoomMessages(roomId, query) {
  const { limit, before } = parsePagination(query);

  const docs = await Message.find(buildPageQuery(roomId, before))
    .sort({ _id: -1 })
    .limit(limit)
    .lean();

  const messages = docs.map((doc) => ({
    id: String(doc._id),
    roomId: doc.roomId,
    content: doc.content,
    sender: {
      id: String(doc.sender),
      username: doc.senderUsername,
    },
    timestamp: doc.createdAt,
  }));

  return { messages, nextCursor: nextCursor(messages, limit) };
}

module.exports = {
  parsePagination,
  listRoomMessages,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
};
