// Pure function: turns a ticket event into the notifications that should be created.
const LABELS = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved' };

export function buildNotifications({ type, data }) {
  if (!type || !data) return [];
  const id = data.ticketId;
  let list = [];

  switch (type) {
    case 'ticket.created':
      list = [{ recipient: 'agents', message: `New ${data.priority} priority ticket #${id}: ${data.title}` }];
      break;
    case 'ticket.assigned':
      if (data.assigneeEmail) {
        list = [{ recipient: data.requesterEmail, message: `Ticket #${id} was assigned to ${data.assigneeName}` }];
      }
      break;
    case 'ticket.status_changed':
      list = [{ recipient: data.requesterEmail, message: `Ticket #${id} is now ${LABELS[data.status] || data.status}: ${data.title}` }];
      break;
    case 'ticket.commented':
      if (data.actorRole === 'agent') {
        list = [{ recipient: data.requesterEmail, message: `${data.actorName} commented on ticket #${id}` }];
      } else {
        list = [{ recipient: data.assigneeEmail || 'agents', message: `${data.actorName} commented on ticket #${id}` }];
      }
      break;
    default:
      return [];
  }
  // Never notify people about their own actions.
  return list
    .filter((n) => n.recipient && n.recipient !== data.actorEmail)
    .map((n) => ({ ...n, eventType: type, ticketId: id }));
}
