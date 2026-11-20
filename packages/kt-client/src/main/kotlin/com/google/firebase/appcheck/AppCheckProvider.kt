package com.google.firebase.appcheck

import com.google.android.gms.tasks.Task

fun interface AppCheckProvider {
    fun getToken(): Task<AppCheckToken>
}
