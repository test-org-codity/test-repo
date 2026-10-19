"""Adjacent half-open intervals do not overlap."""

def calculate(a_start, a_end, b_start, b_end):
    return a_start <= b_end and b_start <= a_end
