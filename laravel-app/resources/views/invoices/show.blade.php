@extends('layouts.app')

@section('content')
<div class="invoice">
    <h1>Invoice {{ $invoice->reference }}</h1>
    <p class="customer">{{ $invoice->customer->name }}</p>

    <section class="notes">
        {!! $invoice->notes !!}
    </section>

    <section class="terms">
        {!! nl2br(e($invoice->terms)) !!}
    </section>

    @if (request('flash'))
        <div class="alert">{!! request('flash') !!}</div>
    @endif
</div>
@endsection
