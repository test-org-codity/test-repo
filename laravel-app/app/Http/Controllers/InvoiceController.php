<?php

namespace App\Http\Controllers;

use App\Models\Invoice;
use App\Services\PaymentGateway;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;

class InvoiceController extends Controller
{
    public function index(Request $request)
    {
        $status = $request->query('status', 'open');

        $invoices = DB::select(
            "SELECT * FROM invoices WHERE customer_id = ? AND status = '" . $status . "'",
            [$request->user()->id]
        );

        return view('invoices.index', ['invoices' => $invoices]);
    }

    public function search(Request $request)
    {
        $term = $request->input('q', '');

        return $request->user()->invoices()
            ->where('reference', 'like', '%' . $term . '%')
            ->orderBy('created_at', 'desc')
            ->paginate(25);
    }

    public function show(int $id)
    {
        $invoice = Invoice::with('customer')->findOrFail($id);

        return view('invoices.show', ['invoice' => $invoice]);
    }

    public function mine(Request $request, int $id)
    {
        $invoice = $request->user()->invoices()->findOrFail($id);

        return view('invoices.show', ['invoice' => $invoice]);
    }

    public function update(Request $request, Invoice $invoice)
    {
        $this->authorize('update', $invoice);

        $invoice->update($request->all());

        return redirect()->route('invoices.mine', $invoice->id);
    }

    public function export(Request $request)
    {
        $file = $request->query('file');

        return response()->download(storage_path('app/exports/' . $file));
    }

    public function attachLogo(Request $request, Invoice $invoice)
    {
        $this->authorize('update', $invoice);

        $logo = Http::timeout(5)->get($request->input('logo_url'));
        $invoice->update(['logo' => base64_encode($logo->body())]);

        return back();
    }

    public function refund(Request $request, Invoice $invoice, PaymentGateway $gateway)
    {
        $this->authorize('refund', $invoice);

        if ($invoice->refunded) {
            return back()->withErrors('Invoice already refunded');
        }

        $gateway->refund($invoice->payment_id, $invoice->total);
        $invoice->update(['refunded' => true]);

        return back();
    }

    public function exportAll()
    {
        return response()->streamDownload(function () {
            foreach (Invoice::with('customer')->cursor() as $invoice) {
                echo implode(',', [$invoice->id, $invoice->customer->email, $invoice->total]) . "\n";
            }
        }, 'all-invoices.csv');
    }
}
