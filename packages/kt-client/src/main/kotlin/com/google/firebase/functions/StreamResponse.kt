package com.google.firebase.functions

sealed class StreamResponse {
    class Message(val message: HttpsCallableResult) : StreamResponse() {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Message) return false
            return message == other.message
        }

        override fun hashCode(): Int = message.hashCode()

        override fun toString(): String = "StreamResponse.Message(message=$message)"
    }

    class Result(val result: HttpsCallableResult) : StreamResponse() {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Result) return false
            return result == other.result
        }

        override fun hashCode(): Int = result.hashCode()

        override fun toString(): String = "StreamResponse.Result(result=$result)"
    }
}
