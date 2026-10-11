<?php

use App\Http\Controllers\InvoiceController;
use Illuminate\Support\Facades\Route;

Route::middleware(['auth'])->group(function () {
    Route::get('/invoices', [InvoiceController::class, 'index'])->name('invoices.index');
    Route::get('/invoices/search', [InvoiceController::class, 'search'])->name('invoices.search');
    Route::get('/invoices/{id}', [InvoiceController::class, 'show'])->name('invoices.show');
    Route::get('/my/invoices/{id}', [InvoiceController::class, 'mine'])->name('invoices.mine');
    Route::put('/invoices/{invoice}', [InvoiceController::class, 'update'])->name('invoices.update');
    Route::get('/invoices-export', [InvoiceController::class, 'export'])->name('invoices.export');
    Route::post('/invoices/{invoice}/logo', [InvoiceController::class, 'attachLogo'])->name('invoices.logo');
    Route::post('/invoices/{invoice}/refund', [InvoiceController::class, 'refund'])->name('invoices.refund');
});

Route::get('/admin/invoices/export-all', [InvoiceController::class, 'exportAll'])->name('admin.invoices.export');
