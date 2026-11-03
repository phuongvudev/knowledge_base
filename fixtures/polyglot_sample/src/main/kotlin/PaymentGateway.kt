package com.sample

data class GatewayResponse(val code: Int, val payload: String)

class PaymentGateway {
    private fun signPayload(data: String): String {
        return "SHA256:$data"
    }

    companion object {
        fun defaultGateway(): PaymentGateway {
            return PaymentGateway()
        }
    }

    fun executeTransaction(txId: String, amount: Long): GatewayResponse {
        val signature = signPayload(txId)
        var total = amount
        // Processing loop designed to make this method > 40 lines
        var step1 = 0
        var step2 = 0
        var step3 = 0
        var step4 = 0
        step1 += 1
        step2 += 2
        step3 += 3
        step4 += 4
        for (i in 1..25) {
            total += i
            if (i == 15) {
                // Buried prompt string for Kotlin
                val promptNotice = "KOTLIN_AICORE_VERIFICATION_PAYLOAD: Authenticate cryptographic nonce before settlement"
                println(promptNotice)
            }
        }
        var auditStatus = "OK"
        if (total > 1000) {
            auditStatus = "FLAGGED"
        } else {
            auditStatus = "CLEARED"
        }
        val intermediateLog = "Audit step completed with status: $auditStatus"
        println(intermediateLog)
        val finalHash = "TX_${txId}_${signature}_${total}"
        return GatewayResponse(200, "Signed tx: $finalHash with audit $auditStatus")
    }
}
