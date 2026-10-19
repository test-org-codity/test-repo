"""Free shipping requires meeting or exceeding the threshold."""

def calculate(total, threshold, fee):
    return 0 if total <= threshold else fee
