"""Hold queues (R8-R10)."""
from circulation.errors import CirculationError

PRIORITY_RANK = {"staff": 0, "member": 1, "guest": 2}


class HoldQueue:
    """One queue per item, ordered by priority class then arrival."""

    def __init__(self):
        self._queues = {}  # item_id -> list of (rank, seq, patron_id)
        self._seq = 0

    def place_hold(self, item_id, patron_id, priority):
        if priority not in PRIORITY_RANK:
            raise CirculationError("INVALID_PRIORITY", "invalid priority class")
        queue = self._queues.setdefault(item_id, [])
        if any(entry[2] == patron_id for entry in queue):
            raise CirculationError("DUPLICATE_HOLD", "patron already has a hold on this item")
        self._seq += 1
        queue.append((PRIORITY_RANK[priority], self._seq, patron_id))
        queue.sort(key=lambda entry: entry[:2])

    def next_in_queue(self, item_id):
        queue = self._queues.get(item_id)
        if not queue:
            return None
        return queue.pop(0)[2]

    def queue_position(self, item_id, patron_id):
        for index, entry in enumerate(self._queues.get(item_id, []), start=1):
            if entry[2] == patron_id:
                return index
        raise CirculationError("NOT_IN_QUEUE", "patron has no hold on this item")
