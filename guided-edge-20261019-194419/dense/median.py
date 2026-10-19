"""The median of two middle values is their mean."""

def calculate(values):
    values=sorted(values)
    return values[len(values)//2]
