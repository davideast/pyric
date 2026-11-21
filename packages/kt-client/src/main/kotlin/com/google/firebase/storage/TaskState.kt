package com.google.firebase.storage

sealed class TaskState<out T> private constructor() {
    class InProgress<T>(val snapshot: T) : TaskState<T>()
    class Paused<T>(val snapshot: T) : TaskState<T>()
}
