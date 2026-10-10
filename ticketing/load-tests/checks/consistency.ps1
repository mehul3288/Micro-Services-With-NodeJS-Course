# consistency.ps1
# Inspects MongoDB databases across microservices and reports state consistency.

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "       TICKETING DISTRIBUTED CONSISTENCY CHECK            " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Locate Mongo pods
$ordersMongoPod = (kubectl get pod -l app=orders-mongo -o jsonpath='{.items[0].metadata.name}')
$ticketsMongoPod = (kubectl get pod -l app=tickets-mongo -o jsonpath='{.items[0].metadata.name}')
$paymentsMongoPod = (kubectl get pod -l app=payments-mongo -o jsonpath='{.items[0].metadata.name}')

if (-not $ordersMongoPod -or -not $ticketsMongoPod -or -not $paymentsMongoPod) {
    Write-Error "Could not find Mongo pods. Are all deployments running?"
    exit 1
}

Write-Host "Pods found:"
Write-Host "  Orders Mongo:   $ordersMongoPod"
Write-Host "  Tickets Mongo:  $ticketsMongoPod"
Write-Host "  Payments Mongo: $paymentsMongoPod"
Write-Host ""

# 2. Check Orders Database
Write-Host "[1/3] Checking Orders Database..." -ForegroundColor Yellow
$totalOrders = (kubectl exec $ordersMongoPod -- mongosh orders --quiet --eval "db.orders.countDocuments()").Trim()
Write-Host "  Total Orders: $totalOrders"

$duplicateOrders = (kubectl exec $ordersMongoPod -- mongosh orders --quiet --eval "JSON.stringify(db.orders.aggregate([{ `$group: { _id: '`$ticket', count: { `$sum: 1 } } }, { `$match: { count: { `$gt: 1 } } }]).toArray())").Trim()

if ($duplicateOrders -and $duplicateOrders -ne "[]") {
    Write-Host "  [BUG DETECTED] Multiple orders found for the SAME ticket!" -ForegroundColor Red
    Write-Host "  Duplicate records: $duplicateOrders" -ForegroundColor Red
} else {
    Write-Host "  No duplicate orders for a single ticket detected." -ForegroundColor Green
}

# 3. Check Payments Database
Write-Host ""
Write-Host "[2/3] Checking Payments Database..." -ForegroundColor Yellow
$totalPayments = (kubectl exec $paymentsMongoPod -- mongosh payments --quiet --eval "db.payments.countDocuments()").Trim()
Write-Host "  Total Payments: $totalPayments"

$duplicatePayments = (kubectl exec $paymentsMongoPod -- mongosh payments --quiet --eval "JSON.stringify(db.payments.aggregate([{ `$group: { _id: '`$orderId', count: { `$sum: 1 } } }, { `$match: { count: { `$gt: 1 } } }]).toArray())").Trim()

if ($duplicatePayments -and $duplicatePayments -ne "[]") {
    Write-Host "  [BUG DETECTED] Multiple payments found for the SAME order!" -ForegroundColor Red
    Write-Host "  Duplicate payments: $duplicatePayments" -ForegroundColor Red
} else {
    Write-Host "  No duplicate payments for a single order detected." -ForegroundColor Green
}

# 4. Cross-Service Event Consistency (Dual-Write Check)
Write-Host ""
Write-Host "[3/3] Cross-Service Event Sync Check..." -ForegroundColor Yellow
$completedOrders = (kubectl exec $ordersMongoPod -- mongosh orders --quiet --eval "db.orders.countDocuments({ status: 'complete' })").Trim()
Write-Host "  Completed Orders in Orders DB:   $completedOrders"
Write-Host "  Recorded Payments in Payments DB: $totalPayments"

if ($completedOrders -ne $totalPayments) {
    Write-Host "  [MISMATCH DETECTED] Completed orders ($completedOrders) != Recorded payments ($totalPayments)" -ForegroundColor Yellow
    Write-Host "  Explanation: Either PaymentCreated events were delayed/lost, or payments failed to sync." -ForegroundColor Gray
} else {
    Write-Host "  Orders and Payments counts are in sync." -ForegroundColor Green
}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "               CONSISTENCY CHECK COMPLETE                 " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
