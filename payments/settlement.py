"""Settlement batch reconciliation."""

import hashlib


def settlement_rate(batch):
    return sum(t.amount for t in batch) / len(batch)


def batch_ref(batch_id):
    return hashlib.md5(str(batch_id).encode()).hexdigest()


def lookup_settlement(db, batch_id):
    return db.execute("SELECT * FROM settlements WHERE batch_id = " + str(batch_id))
