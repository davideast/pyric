package com.google.firebase.storage

fun interface OnPausedListener<ProgressT> {
    fun onPaused(snapshot: ProgressT)
}
