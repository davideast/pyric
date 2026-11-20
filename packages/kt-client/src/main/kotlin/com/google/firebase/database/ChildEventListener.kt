package com.google.firebase.database

interface ChildEventListener {
    fun onChildAdded(snapshot: DataSnapshot, previousChildName: String?)
    fun onChildChanged(snapshot: DataSnapshot, previousChildName: String?)
    fun onChildRemoved(snapshot: DataSnapshot)
    fun onChildMoved(snapshot: DataSnapshot, previousChildName: String?)
    fun onCancelled(error: DatabaseError)
}
